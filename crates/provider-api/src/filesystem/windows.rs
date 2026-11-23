//! Local-volume handles. Ancestors are opened in order without sharing delete
//! access, so a path cannot be moved away while we open or mutate a child.
#[path = "windows/rewrite.rs"]
pub(super) mod rewrite;

use super::is_link;
use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io,
    mem::{MaybeUninit, size_of},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::{Component, Path, PathBuf, Prefix},
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_BASIC_INFO, FILE_DISPOSITION_INFO_EX, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FileBasicInfo, FileDispositionInfoEx, FileIdInfo,
    GetDriveTypeW, GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
    SetFileInformationByHandle,
};

/// Resolve Documents for the current Windows account, including redirection.
pub fn documents_directory() -> Option<PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, ptr, slice};
    use windows_sys::Win32::{
        System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize},
        UI::Shell::{FOLDERID_Documents, SHGetKnownFolderPath},
    };

    // SAFETY: COM is initialized and uninitialized on this thread. On success,
    // the shell returns a terminated UTF-16 string owned by the COM allocator.
    unsafe {
        if CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32) < 0 {
            return None;
        }
        let mut buffer = ptr::null_mut();
        let result = SHGetKnownFolderPath(&FOLDERID_Documents, 0, ptr::null_mut(), &mut buffer);
        let path = (result >= 0 && !buffer.is_null()).then(|| {
            let length = (0..).take_while(|&index| *buffer.add(index) != 0).count();
            PathBuf::from(OsString::from_wide(slice::from_raw_parts(buffer, length)))
        });
        CoTaskMemFree(buffer.cast());
        CoUninitialize();
        path.filter(|path| path.is_absolute())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub volume: u64,
    pub id: [u8; 16],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Item {
    pub identity: Identity,
    pub directory: bool,
    pub bytes: u64,
    pub changed: i64,
    pub modified: i64,
    pub attributes: u32,
}

impl Item {
    pub fn from_file(file: &File) -> io::Result<Self> {
        let metadata = file.metadata()?;
        if is_link(&metadata) || !(metadata.is_dir() || metadata.is_file()) {
            return Err(invalid("reparse point or unsupported object"));
        }
        if metadata.is_file() {
            // Keep the existing link-count check, even though object identity
            // below uses all 128 bits from FileIdInfo.
            super::windows_file_identity(file)?;
        }
        let mut id = MaybeUninit::<FILE_ID_INFO>::uninit();
        let mut basic = MaybeUninit::<FILE_BASIC_INFO>::uninit();
        // SAFETY: each class receives a correctly sized writable Win32
        // structure. The borrowed handle remains live throughout the calls.
        let (id, basic) = unsafe {
            if GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                id.as_mut_ptr().cast(),
                size_of::<FILE_ID_INFO>() as u32,
            ) == 0
                || GetFileInformationByHandleEx(
                    file.as_raw_handle(),
                    FileBasicInfo,
                    basic.as_mut_ptr().cast(),
                    size_of::<FILE_BASIC_INFO>() as u32,
                ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            (id.assume_init(), basic.assume_init())
        };
        Ok(Self {
            identity: Identity {
                volume: id.VolumeSerialNumber,
                id: id.FileId.Identifier,
            },
            directory: metadata.is_dir(),
            bytes: if metadata.is_dir() { 0 } else { metadata.len() },
            changed: basic.ChangeTime,
            modified: basic.LastWriteTime,
            attributes: basic.FileAttributes,
        })
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn safe_name(name: &OsStr) -> bool {
    let units = name.encode_wide();
    !units
        .clone()
        .any(|unit| matches!(unit, 0..=31 | 34 | 42 | 47 | 58 | 60 | 62 | 63 | 92 | 124))
        && units.last().is_some_and(|last| !matches!(last, 32 | 46))
}

// Use the verbatim local DOS form only. UNC, NT device paths, ADS and
// path components with Win32 normalization ambiguities are outside this scope.
pub fn canonical_local_path(path: &Path) -> io::Result<PathBuf> {
    let mut components = path.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive.to_ascii_uppercase(),
            _ => return Err(invalid("network or device path")),
        },
        _ => return Err(invalid("local drive path required")),
    };
    if components.next() != Some(Component::RootDir) {
        return Err(invalid("absolute local drive path required"));
    }
    let mut path = PathBuf::from(format!("\\\\?\\{}:\\", char::from(drive)));
    for component in components {
        match component {
            Component::Normal(name) if safe_name(name) => path.push(name),
            _ => return Err(invalid("ambiguous path component")),
        }
    }
    Ok(path)
}

fn open(path: &Path, access: u32, share: u32) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(access)
        .share_mode(share)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

/// A package path established by Windows package registration can sit behind
/// an ancestor whose metadata ACL denies traversal by individual handles.
pub(crate) fn open_registered_executable(path: &Path) -> io::Result<File> {
    use windows_sys::Win32::Foundation::GENERIC_READ;
    let path = canonical_local_path(path)?;
    let file = open(&path, GENERIC_READ, FILE_SHARE_READ)?;
    if Item::from_file(&file)?.directory {
        return Err(invalid("provider executable is not a regular file"));
    }
    let expected: Vec<u16> = path.as_os_str().encode_wide().collect();
    let mut actual = vec![0u16; expected.len() + 1];
    // SAFETY: the file handle is live and actual is a writable UTF-16 buffer.
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            actual.as_mut_ptr(),
            actual.len() as u32,
            0,
        )
    } as usize;
    if count != expected.len() || actual[..count] != expected {
        return Err(invalid(
            "registered provider executable resolved to another path",
        ));
    }
    Ok(file)
}

pub struct Directory {
    path: PathBuf,
    ancestors: Vec<File>,
    item: Item,
}

impl Directory {
    pub fn open(path: &Path) -> io::Result<Self> {
        let path = canonical_local_path(path)?;
        let mut components = path.components();
        components.next();
        components.next();
        let root = path
            .ancestors()
            .last()
            .ok_or_else(|| invalid("missing drive root"))?
            .to_owned();
        let drive: Vec<u16> = root.as_os_str().encode_wide().skip(4).chain([0]).collect();
        // SAFETY: drive holds a NUL-terminated absolute drive root.
        let drive_type = unsafe { GetDriveTypeW(drive.as_ptr()) };
        if !matches!(drive_type, 2 | 3 | 6) {
            return Err(invalid("unsupported drive type"));
        }
        let handle = open(&root, FILE_READ_ATTRIBUTES, FILE_SHARE_READ)?;
        let mut actual = [0u16; 260];
        // SAFETY: the live root handle and fixed output buffer are valid.
        let count = unsafe {
            GetFinalPathNameByHandleW(
                handle.as_raw_handle(),
                actual.as_mut_ptr(),
                actual.len() as u32,
                0,
            )
        } as usize;
        if count == 0
            || count >= actual.len()
            || !root
                .as_os_str()
                .encode_wide()
                .eq(actual[..count].iter().copied())
        {
            return Err(invalid(
                "drive root is a device alias or cannot be verified",
            ));
        }
        let item = Item::from_file(&handle)?;
        if !item.directory {
            return Err(invalid("invalid drive root"));
        }
        let mut root = Self {
            path: root,
            ancestors: vec![handle],
            item,
        };
        for component in components {
            root.push(component.as_os_str())?;
        }
        Ok(root)
    }

    fn push(&mut self, component: &OsStr) -> io::Result<()> {
        self.path.push(component);
        let handle = open(&self.path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ)?;
        let item = Item::from_file(&handle)?;
        if !item.directory || item.identity.volume != self.item.identity.volume {
            return Err(invalid("linked directory or different volume"));
        }
        self.ancestors.push(handle);
        self.item = item;
        Ok(())
    }

    /// Create private scratch storage outside the selected archive, including
    /// when the temporary directory is configured through an alias.
    pub fn tempdir_outside(&self, prefix: &str) -> io::Result<tempfile::TempDir> {
        let base = std::env::temp_dir();
        let directory = Self::open(&base)?;
        for ancestor in &directory.ancestors {
            if Item::from_file(ancestor)?.identity == self.item.identity {
                return Err(invalid("temporary directory is inside the provider root"));
            }
        }
        tempfile::Builder::new().prefix(prefix).tempdir_in(&base)
    }

    pub fn item(&self) -> Item {
        self.item
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn scoped_path(&self, path: &Path) -> io::Result<PathBuf> {
        let path = canonical_local_path(path)?;
        if path.starts_with(&self.path) {
            return Ok(path);
        }
        // Case and 8.3 spellings can differ inside SQLite. Check the
        // alternative root by volume and file ID before using its suffix.
        let depth = path
            .components()
            .count()
            .checked_sub(self.path.components().count())
            .ok_or_else(|| invalid("path outside root"))?;
        let prefix = path
            .ancestors()
            .nth(depth)
            .ok_or_else(|| invalid("path outside root"))?;
        if Self::open(prefix)?.item.identity != self.item.identity {
            return Err(invalid("path outside root"));
        }
        let suffix = path
            .strip_prefix(prefix)
            .map_err(|_| invalid("path outside root"))?;
        Ok(self.path.join(suffix))
    }

    pub fn child(&self, path: &Path) -> io::Result<Self> {
        let path = self.scoped_path(path)?;
        let relative = path
            .strip_prefix(&self.path)
            .map_err(|_| invalid("path outside root"))?;
        let mut child = Self {
            path: self.path.clone(),
            ancestors: Vec::new(),
            item: self.item,
        };
        child.ancestors = self
            .ancestors
            .iter()
            .map(File::try_clone)
            .collect::<io::Result<_>>()?;
        for component in relative.components() {
            child.push(component.as_os_str())?;
        }
        Ok(child)
    }

    fn with_parent<T>(
        &self,
        path: &Path,
        action: impl FnOnce(&Path, &Self) -> io::Result<T>,
    ) -> io::Result<T> {
        let path = self.scoped_path(path)?;
        let parent = self.child(path.parent().ok_or_else(|| invalid("missing parent"))?)?;
        action(&path, &parent)
    }

    fn check_volume(&self, item: Item) -> io::Result<Item> {
        if item.identity.volume != self.item.identity.volume {
            return Err(invalid("object on a different volume"));
        }
        Ok(item)
    }

    pub fn inspect(&self, path: &Path) -> io::Result<Item> {
        self.with_parent(path, |path, parent| {
            let file = open(
                path,
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
            )?;
            parent.check_volume(Item::from_file(&file)?)
        })
    }

    pub fn open_read(&self, path: &Path) -> io::Result<File> {
        // Observers (including paged decoders) can retain an identity-bound
        // handle. A reader must not prevent the provider from renaming or
        // deleting the observed entry.
        self.open_read_sharing(path, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
    }

    /// Keep a verified file in place while allowing concurrent reads and writes.
    pub fn pin_shared_file(&self, path: &Path) -> io::Result<File> {
        self.open_read_sharing(path, FILE_SHARE_READ | FILE_SHARE_WRITE)
    }

    pub(crate) fn pin_executable(&self, path: &Path) -> io::Result<File> {
        self.open_read_sharing(path, FILE_SHARE_READ)
    }

    fn open_read_sharing(&self, path: &Path, share: u32) -> io::Result<File> {
        self.with_parent(path, |path, parent| {
            let file = open(path, windows_sys::Win32::Foundation::GENERIC_READ, share)?;
            if parent.check_volume(Item::from_file(&file)?)?.directory {
                return Err(invalid("regular file required"));
            }
            Ok(file)
        })
    }

    pub fn entries(&self) -> io::Result<impl Iterator<Item = io::Result<std::ffi::OsString>> + '_> {
        Ok(fs::read_dir(self.path())?.map(|entry| entry.map(|entry| entry.file_name())))
    }

    pub fn remove(&self, path: &Path, expected: Item) -> io::Result<u64> {
        self.with_parent(path, |path, parent| {
            // Refuse active writers and competing delete handles. The file
            // disposition below acts on the verified handle, never on a name.
            let file = open(path, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ)?;
            let live = parent.check_volume(Item::from_file(&file)?)?;
            if live.identity != expected.identity
                || live.directory != expected.directory
                || (!live.directory && live != expected)
            {
                return Err(invalid("object changed after review"));
            }
            Self::dispose(&file)?;
            Ok(live.bytes)
        })
    }

    fn dispose(file: &File) -> io::Result<()> {
        let disposition = FILE_DISPOSITION_INFO_EX { Flags: 0x01 | 0x02 };
        // SAFETY: the handle has DELETE access. The structure describes an
        // unlink on close using POSIX semantics and never ignores read-only
        // attributes. Windows refuses the disposition for nonempty directories.
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfoEx,
                (&raw const disposition).cast(),
                size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn scoped_removal_checks_identity_content_and_directory_emptiness() -> io::Result<()> {
        let fixture = tempfile::tempdir()?;
        let root = Directory::open(fixture.path())?;
        let folder = root
            .path()
            .join("project with spaces 日本")
            .join("a".repeat(190));
        fs::create_dir_all(&folder)?;
        let target = folder.join("session-é.jsonl");
        fs::write(&target, b"old")?;
        let old = root.inspect(&target)?;
        let moved = folder.join("original");
        fs::rename(&target, &moved)?;
        fs::write(&target, b"replacement")?;
        assert!(root.remove(&target, old).is_err());
        assert_eq!(fs::read(&target)?, b"replacement");

        let current = root.inspect(&target)?;
        let mut writer = fs::OpenOptions::new().append(true).open(&target)?;
        assert!(root.remove(&target, current).is_err());
        writer.write_all(b"!")?;
        drop(writer);
        assert!(root.remove(&target, current).is_err());

        let shared = folder.join("hard link");
        fs::hard_link(&target, &shared)?;
        assert!(root.inspect(&target).is_err());
        assert!(root.open_read(&shared).is_err());
        fs::remove_file(&shared)?;
        let directory = root.inspect(&folder)?;
        assert_eq!(root.remove(&target, root.inspect(&target)?)?, 12);
        assert!(root.remove(&folder, directory).is_err());
        assert_eq!(fs::read(&moved)?, b"old");
        root.remove(&moved, root.inspect(&moved)?)?;
        root.remove(&folder, directory)?;
        assert!(!folder.exists());
        Ok(())
    }

    #[test]
    fn rewrite_preserves_unrelated_bytes_and_honors_exclusive_lock() -> io::Result<()> {
        use super::rewrite::{DirectoryLock, replace};
        let fixture = tempfile::tempdir()?;
        let root = Directory::open(fixture.path())?;
        let path = root.path().join("history.jsonl");
        fs::write(&path, b"remove\r\nkeep\r\n")?;
        let lock = DirectoryLock::create(&root, "history.jsonl.lock").expect("create history lock");
        assert!(DirectoryLock::create(&root, "history.jsonl.lock").is_err());
        let rewrite = |input: &File, output: &mut dyn Write| {
            crate::rewrite::filter_jsonl(input, output, |line| line == b"remove\r\n")
        };
        let writer = fs::OpenOptions::new().append(true).open(&path)?;
        assert!(replace(&root, "history.jsonl", rewrite, || lock.refresh()).is_err());
        drop(writer);
        assert_eq!(
            replace(&root, "history.jsonl", rewrite, || lock.refresh())
                .expect("rewrite under lock"),
            1
        );
        assert_eq!(fs::read(&path)?, b"keep\r\n");
        drop(lock);
        assert!(!root.path().join("history.jsonl.lock").exists());
        Ok(())
    }
}
