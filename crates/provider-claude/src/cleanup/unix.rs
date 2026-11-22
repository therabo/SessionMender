use agentmender_provider_api::rewrite::{DIR_FLAGS, directory};
use rustix::fs::{self, AtFlags, Dir, FileType, Mode, Stat};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io,
    os::unix::ffi::OsStrExt,
    path::{Component, Path},
};

#[derive(PartialEq, Eq)]
pub(super) struct Object {
    identity: (i32, u64),
    kind: FileType,
    exclusive_file: bool,
    pub directory: bool,
    pub bytes: u64,
}

impl Object {
    pub fn inspect(root: &Path, relative: &Path, exclusive_file: bool) -> io::Result<Self> {
        let (parent, name) = open_parent(root, relative)?;
        let info = fs::statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW)?;
        let kind = FileType::from_raw_mode(info.st_mode);
        if info.st_dev != fs::fstat(parent)?.st_dev
            || exclusive_file && (kind != FileType::RegularFile || info.st_nlink != 1)
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(Self {
            identity: (info.st_dev, info.st_ino),
            kind,
            exclusive_file,
            directory: kind == FileType::Directory,
            bytes: logical_bytes(&info),
        })
    }

    pub fn remove(&self, root: &Path, relative: &Path) -> io::Result<u64> {
        let (parent, name) = open_parent(root, relative)?;
        let current = fs::statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW)?;
        if (current.st_dev, current.st_ino) != self.identity
            || (self.exclusive_file && current.st_nlink != 1)
            || FileType::from_raw_mode(current.st_mode) != self.kind
        {
            return Err(io::Error::other("Risorsa cambiata dopo l’anteprima."));
        }
        let flags = if self.directory {
            AtFlags::REMOVEDIR
        } else {
            AtFlags::empty()
        };
        fs::unlinkat(parent, name, flags)?;
        Ok(logical_bytes(&current))
    }
}

pub(super) fn names(root: &Path, relative: &Path) -> io::Result<Vec<OsString>> {
    let (parent, name) = open_parent(root, relative)?;
    let dir = open_child_dir(&parent, name)?;
    Dir::read_from(&dir)?
        .filter_map(|entry| match entry {
            Ok(entry) if matches!(entry.file_name().to_bytes(), b"." | b"..") => None,
            Ok(entry) => Some(Ok(
                OsStr::from_bytes(entry.file_name().to_bytes()).to_owned()
            )),
            Err(error) => Some(Err(error.into())),
        })
        .collect()
}

pub(super) fn unique_transcript(root: &Path, selected: &Path) -> io::Result<bool> {
    let projects = match directory(&root.join("projects")) {
        Ok(projects) => projects,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    let transcript_name = selected
        .file_name()
        .expect("recognized transcript filename");
    for entry in Dir::read_from(&projects)? {
        let entry = entry?;
        let name = OsStr::from_bytes(entry.file_name().to_bytes());
        if name == "."
            || name == ".."
            || root.join("projects").join(name).join(transcript_name) == selected
        {
            continue;
        }
        let info = fs::statat(&projects, name, AtFlags::SYMLINK_NOFOLLOW)?;
        if FileType::from_raw_mode(info.st_mode) == FileType::Directory {
            let namespace = open_child_dir(&projects, name)?;
            match fs::statat(&namespace, transcript_name, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(_) => return Ok(false),
                Err(rustix::io::Errno::NOENT) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(true)
}

fn logical_bytes(info: &Stat) -> u64 {
    if FileType::from_raw_mode(info.st_mode) == FileType::RegularFile && info.st_nlink == 1 {
        info.st_size.try_into().unwrap_or_default()
    } else {
        0
    }
}

fn open_child_dir(parent: &File, name: &OsStr) -> io::Result<File> {
    let dir = fs::openat(parent, name, DIR_FLAGS, Mode::empty())?;
    if fs::fstat(&dir)?.st_dev != fs::fstat(parent)?.st_dev {
        return Err(io::Error::other(
            "Percorso su un volume estraneo all’archivio.",
        ));
    }
    Ok(File::from(dir))
}

fn open_parent<'a>(root: &Path, relative: &'a Path) -> io::Result<(File, &'a OsStr)> {
    let name = relative.file_name().ok_or(io::ErrorKind::InvalidInput)?;
    let parent = relative.parent().ok_or(io::ErrorKind::InvalidInput)?;
    if !relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut dir = directory(root)?;
    for component in parent.components() {
        dir = open_child_dir(&dir, component.as_os_str())?;
    }
    Ok((dir, name))
}
