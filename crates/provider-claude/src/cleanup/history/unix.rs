use super::{HISTORY, LOCK};
use agentmender_provider_api::rewrite::DIR_FLAGS;
use rustix::fs::{self, AtFlags, Mode, Timespec, Timestamps, UTIME_NOW, UTIME_OMIT};
use std::{fs::File, io};

pub(super) struct HistoryLock<'a> {
    root: &'a File,
    handle: File,
    identity: (i32, u64),
}

impl HistoryLock<'_> {
    fn held(&self) -> bool {
        fs::statat(self.root, LOCK, AtFlags::SYMLINK_NOFOLLOW)
            .is_ok_and(|stat| (stat.st_dev, stat.st_ino) == self.identity)
    }

    pub(super) fn refresh(&self) -> io::Result<()> {
        if !self.held() {
            return Err(io::Error::other("The history lock changed."));
        }
        fs::futimens(
            &self.handle,
            &Timestamps {
                last_access: Timespec {
                    tv_sec: 0,
                    tv_nsec: UTIME_OMIT,
                },
                last_modification: Timespec {
                    tv_sec: 0,
                    tv_nsec: UTIME_NOW,
                },
            },
        )?;
        Ok(())
    }
}

impl Drop for HistoryLock<'_> {
    fn drop(&mut self) {
        if self.held() {
            let _ = fs::unlinkat(self.root, LOCK, AtFlags::REMOVEDIR);
        }
    }
}

pub(super) fn acquire(root: &File) -> io::Result<Option<HistoryLock<'_>>> {
    if matches!(
        fs::statat(root, HISTORY, AtFlags::SYMLINK_NOFOLLOW),
        Err(rustix::io::Errno::NOENT)
    ) {
        return Ok(None);
    }
    fs::mkdirat(root, LOCK, Mode::RUSR | Mode::WUSR | Mode::XUSR).map_err(|error| {
        if error == rustix::io::Errno::EXIST {
            io::Error::other("The history file is busy. Its entries were preserved.")
        } else {
            error.into()
        }
    })?;
    let handle = fs::openat(root, LOCK, DIR_FLAGS, Mode::empty())?;
    let observed = fs::fstat(&handle)?;
    Ok(Some(HistoryLock {
        root,
        handle: File::from(handle),
        identity: (observed.st_dev, observed.st_ino),
    }))
}
