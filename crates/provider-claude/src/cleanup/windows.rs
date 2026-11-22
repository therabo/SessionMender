use agentmender_provider_api::filesystem::{Directory, Item};
use std::{ffi::OsString, io, path::Path};

#[derive(PartialEq, Eq)]
pub(super) struct Object {
    root: Item,
    item: Item,
    pub directory: bool,
    pub bytes: u64,
}

impl Object {
    pub fn inspect(root: &Path, relative: &Path, exclusive_file: bool) -> io::Result<Self> {
        let directory = Directory::open(root)?;
        let item = directory.inspect(&directory.path().join(relative))?;
        if exclusive_file && item.directory {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(Self {
            root: directory.item(),
            item,
            directory: item.directory,
            bytes: item.bytes,
        })
    }

    pub fn remove(&self, root: &Path, relative: &Path) -> io::Result<u64> {
        let directory = Directory::open(root)?;
        if directory.item().identity != self.root.identity {
            return Err(io::Error::other("Radice Claude cambiata dopo l’anteprima."));
        }
        directory.remove(&directory.path().join(relative), self.item)
    }
}

pub(super) fn names(root: &Path, relative: &Path) -> io::Result<Vec<OsString>> {
    let directory = Directory::open(root)?;
    directory
        .child(&directory.path().join(relative))?
        .entries()?
        .collect()
}

pub(super) fn unique_transcript(root: &Path, selected: &Path) -> io::Result<bool> {
    let root = Directory::open(root)?;
    let projects = match root.child(&root.path().join("projects")) {
        Ok(projects) => projects,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    let selected = agentmender_provider_api::filesystem::canonical_local_path(selected)?;
    let name = selected.file_name().ok_or(io::ErrorKind::InvalidInput)?;
    for namespace in projects.entries()? {
        let namespace = projects.path().join(namespace?);
        if !projects.inspect(&namespace)?.directory {
            continue;
        }
        let path = namespace.join(name);
        if path == selected {
            continue;
        }
        match projects.inspect(&path) {
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}
