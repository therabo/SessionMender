//! Rewrite local prompt history under Claude's canonical directory lock.
#[cfg(unix)]
mod unix;
use agentmender_provider_api::rewrite::{self, directory};
use std::{
    io,
    path::Path,
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::Duration,
};
#[cfg(unix)]
use unix::acquire;
#[cfg(windows)]
use windows::acquire;

const HISTORY: &str = "history.jsonl";
const LOCK: &str = "history.jsonl.lock";

pub(super) fn count_rows(path: &Path, id: &str) -> io::Result<usize> {
    let file = rewrite::open_file(&directory(path)?, HISTORY)?;
    rewrite::filter_jsonl(&file, &mut io::sink(), |line| matches_id(line, id))
}

pub(super) fn remove_rows(path: &Path, id: &str) -> io::Result<usize> {
    let root = directory(path)?;
    let Some(lock) = acquire(&root)? else {
        return Ok(0);
    };
    with_heartbeat(
        || lock.refresh(),
        || {
            rewrite::replace(
                &root,
                HISTORY,
                |input, output| rewrite::filter_jsonl(input, output, |line| matches_id(line, id)),
                || lock.refresh(),
            )
        },
    )
}

fn with_heartbeat<T>(
    refresh: impl Fn() -> io::Result<()> + Sync,
    rewrite: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    thread::scope(|scope| {
        let (stop, receiver) = mpsc::channel::<()>();
        // Claude's proper-lockfile treats the directory as stale after 10 seconds.
        let refresh = &refresh;
        scope.spawn(move || {
            while let Err(RecvTimeoutError::Timeout) = receiver.recv_timeout(Duration::from_secs(2))
            {
                if refresh().is_err() {
                    break;
                }
            }
        });
        let result = rewrite();
        drop(stop);
        result
    })
}

fn matches_id(line: &[u8], id: &str) -> bool {
    let Ok(row) = serde_json::from_slice::<serde_json::Value>(line) else {
        return false;
    };
    row.get("sessionId")
        .filter(|value| !value.is_null())
        .or_else(|| row.get("session_id"))
        .and_then(serde_json::Value::as_str)
        == Some(id)
}

#[cfg(windows)]
mod windows {
    use super::{HISTORY, LOCK};
    use agentmender_provider_api::{filesystem::Directory, rewrite::DirectoryLock};
    use std::io;

    pub(super) fn acquire(root: &Directory) -> io::Result<Option<DirectoryLock>> {
        match root.inspect(&root.path().join(HISTORY)) {
            Ok(item) if !item.directory => {}
            Ok(_) => return Err(io::ErrorKind::InvalidData.into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
        DirectoryLock::create(root, LOCK)
            .map(Some)
            .map_err(|error| {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    io::Error::other("Cronologia occupata. Le righe sono state conservate.")
                } else {
                    error
                }
            })
    }
}
