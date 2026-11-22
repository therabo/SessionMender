//! Handle-relative lock creation and atomic replacement of provider text files.
use super::{Directory, Item, invalid, open, safe_name};
use std::{
    ffi::OsStr,
    fs::{File, OpenOptions},
    io::{self, BufWriter, Write},
    mem::{offset_of, size_of},
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
    ptr::{null, null_mut},
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_CREATE, FILE_DIRECTORY_FILE, FILE_RENAME_INFORMATION,
            FILE_SYNCHRONOUS_IO_NONALERT, FileRenameInformationEx, NtCreateFile,
            NtSetInformationFile,
        },
    },
    Win32::{
        Foundation::{
            GENERIC_READ, GENERIC_WRITE, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE,
            RtlNtStatusToDosError, UNICODE_STRING,
        },
        Security::{
            DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetKernelObjectSecurity,
            OWNER_SECURITY_INFORMATION, SetKernelObjectSecurity,
        },
        Storage::FileSystem::{
            DELETE, FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
            FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, FILE_ATTRIBUTE_SYSTEM, FILE_BASIC_INFO,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, FileBasicInfo, FileStreamInfo,
            GetFileInformationByHandleEx, READ_CONTROL, SYNCHRONIZE, SetFileInformationByHandle,
            WRITE_DAC, WRITE_OWNER,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

pub fn directory(path: &Path) -> io::Result<Directory> {
    Directory::open(path)
}

fn checked_name(name: &str) -> io::Result<&OsStr> {
    let name = OsStr::new(name);
    if !safe_name(name) {
        return Err(invalid("invalid provider file name"));
    }
    Ok(name)
}

pub fn open_file(root: &Directory, name: &str) -> io::Result<File> {
    root.open_read(&root.path().join(checked_name(name)?))
}

pub struct DirectoryLock(File);

impl DirectoryLock {
    pub fn create(root: &Directory, name: &str) -> io::Result<Self> {
        let mut name: Vec<u16> = checked_name(name)?.encode_wide().collect();
        let length = u16::try_from(name.len() * size_of::<u16>())
            .map_err(|_| invalid("invalid lock name length"))?;
        let name = UNICODE_STRING {
            Length: length,
            MaximumLength: length,
            Buffer: name.as_mut_ptr(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: root
                .ancestors
                .last()
                .expect("directory handle")
                .as_raw_handle(),
            ObjectName: &name,
            Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
            SecurityDescriptor: null(),
            SecurityQualityOfService: null(),
        };
        let mut raw = null_mut();
        let mut status = IO_STATUS_BLOCK::default();
        // SAFETY: all inputs live until the synchronous call returns. The
        // kernel creates exactly one new directory relative to our live root.
        unsafe {
            let result = NtCreateFile(
                &mut raw,
                DELETE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | SYNCHRONIZE,
                &attributes,
                &mut status,
                null(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                FILE_CREATE,
                FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
                null(),
                0,
            );
            if result < 0 {
                return Err(io::Error::from_raw_os_error(
                    RtlNtStatusToDosError(result) as i32
                ));
            }
            Ok(Self(File::from_raw_handle(raw)))
        }
    }

    pub fn refresh(&self) -> io::Result<()> {
        self.0.set_modified(SystemTime::now())
    }
}

impl Drop for DirectoryLock {
    fn drop(&mut self) {
        let _ = Directory::dispose(&self.0);
    }
}

pub fn replace(
    root: &Directory,
    name: &str,
    rewrite: impl FnOnce(&File, &mut dyn Write) -> io::Result<usize>,
    before_commit: impl FnOnce() -> io::Result<()>,
) -> io::Result<usize> {
    let name = checked_name(name)?;
    let path = root.path().join(name);
    // Hold the destination open without sharing write or delete access for the
    // lifetime of the rewrite. Ordinary Windows writers and renames must wait.
    let input = match open(&path, GENERIC_READ, FILE_SHARE_READ) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let initial = root.check_volume(Item::from_file(&input)?)?;
    if initial.directory {
        return Err(invalid("regular file required for rewrite"));
    }

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    let temp = root.path().join(format!(
        ".agentmender-{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .access_mode(GENERIC_WRITE | DELETE | READ_CONTROL | WRITE_DAC | WRITE_OWNER)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(temp)?;
    let result = (|| {
        let mut writer = BufWriter::new(&output);
        let count = rewrite(&input, &mut writer)?;
        if count == 0 {
            return Ok(0);
        }
        writer.flush()?;
        output.sync_all()?;
        preserve_metadata(&input, &output, initial).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("preserving provider file metadata: {error}"),
            )
        })?;
        before_commit()?;
        // Windows requires delete sharing on the destination for replacement.
        // Deny writers across the handoff and check the file again at commit.
        let commit = open(&path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE)?;
        if Item::from_file(&commit)? != initial || Item::from_file(&input)? != initial {
            return Err(invalid("provider file changed during rewrite"));
        }
        drop(input);
        if root.inspect(&path)? != initial || Item::from_file(&commit)? != initial {
            return Err(invalid("provider file changed at rewrite commit"));
        }
        rename_replacing(&output, name).map_err(|error| {
            io::Error::new(error.kind(), format!("replacing provider file: {error}"))
        })?;
        Ok(count)
    })();
    if !matches!(result, Ok(count) if count != 0) {
        let _ = Directory::dispose(&output);
    }
    result
}

const SECURITY: u32 =
    DACL_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION;

fn security(file: &File) -> io::Result<Vec<u64>> {
    // A self-relative descriptor needs aligned storage. Query the size first.
    let mut needed = 0;
    // SAFETY: Windows reports the size through a live out-parameter.
    unsafe { GetKernelObjectSecurity(file.as_raw_handle(), SECURITY, null_mut(), 0, &mut needed) };
    if needed == 0 || needed > 128 * 1024 {
        return Err(invalid("unavailable file security descriptor"));
    }
    let mut data = vec![0u64; (needed as usize).div_ceil(size_of::<u64>())];
    // SAFETY: data is aligned and large enough for the requested descriptor.
    if unsafe {
        GetKernelObjectSecurity(
            file.as_raw_handle(),
            SECURITY,
            data.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(data)
}

fn preserve_metadata(input: &File, output: &File, initial: Item) -> io::Result<()> {
    const SUPPORTED_ATTRIBUTES: u32 = FILE_ATTRIBUTE_ARCHIVE
        | FILE_ATTRIBUTE_HIDDEN
        | FILE_ATTRIBUTE_NORMAL
        | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
        | FILE_ATTRIBUTE_SYSTEM;
    if initial.attributes & !SUPPORTED_ATTRIBUTES != 0 {
        return Err(invalid("provider file has unsupported attributes"));
    }
    let mut streams = [0u64; 64];
    // SAFETY: streams is aligned and sized for a FILE_STREAM_INFO buffer.
    if unsafe {
        GetFileInformationByHandleEx(
            input.as_raw_handle(),
            FileStreamInfo,
            streams.as_mut_ptr().cast(),
            size_of::<[u64; 64]>() as u32,
        )
    } == 0
        || (streams[0] & u64::from(u32::MAX)) != 0
    {
        return Err(invalid("provider file may contain alternate data streams"));
    }
    let mut descriptor = security(input)?;
    // SAFETY: the descriptor was initialized and validated by Windows, and
    // output grants access to set its security. No merge errors are ignored.
    if descriptor != security(output)?
        && unsafe {
            SetKernelObjectSecurity(
                output.as_raw_handle(),
                SECURITY,
                descriptor.as_mut_ptr().cast(),
            )
        } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let basic = FILE_BASIC_INFO {
        FileAttributes: initial.attributes,
        ..FILE_BASIC_INFO::default()
    };
    // SAFETY: basic is a complete FILE_BASIC_INFO structure.
    if unsafe {
        SetFileInformationByHandle(
            output.as_raw_handle(),
            FileBasicInfo,
            (&raw const basic).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn rename_replacing(file: &File, name: &OsStr) -> io::Result<()> {
    let name: Vec<u16> = name.encode_wide().collect();
    let name_bytes = name.len() * size_of::<u16>();
    let length = (offset_of!(FILE_RENAME_INFORMATION, FileName) + name_bytes)
        .max(size_of::<FILE_RENAME_INFORMATION>());
    let mut data = vec![0u64; length.div_ceil(size_of::<u64>())];
    let info = data.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    // SAFETY: data is correctly aligned and sized for the C header plus the
    // UTF-16 tail. The native API interprets a bare name and a null root as
    // a rename within the verified source handle's own directory.
    unsafe {
        (*info).Anonymous.Flags = 0x01 | 0x02;
        (*info).RootDirectory = null_mut();
        (*info).FileNameLength = name_bytes as u32;
        data.as_mut_ptr()
            .cast::<u8>()
            .add(offset_of!(FILE_RENAME_INFORMATION, FileName))
            .cast::<u16>()
            .copy_from_nonoverlapping(name.as_ptr(), name.len());
        let mut status = IO_STATUS_BLOCK::default();
        let result = NtSetInformationFile(
            file.as_raw_handle(),
            &mut status,
            info.cast(),
            length as u32,
            FileRenameInformationEx,
        );
        if result < 0 {
            return Err(io::Error::from_raw_os_error(
                RtlNtStatusToDosError(result) as i32
            ));
        }
    }
    Ok(())
}
