//! Codex inventory, bounded transcript previews and session removal.
#[cfg(any(target_os = "macos", windows))]
mod cleanup;
#[cfg(any(target_os = "macos", windows))]
mod desktop_reconciliation;
pub mod discovery;
pub mod exports;
#[cfg(any(target_os = "macos", windows))]
mod reader;
mod removal;
#[cfg(any(target_os = "macos", windows))]
mod rollout_reader;
#[cfg(any(target_os = "macos", windows))]
mod snapshot;
mod worker;

use agentmender_domain::{Installation, ProviderKind};
use agentmender_provider_api::{ProviderError, ProviderLocation, process, validate_location};
#[cfg(not(windows))]
use std::process::Child;
use std::{path::PathBuf, sync::Mutex};

pub use removal::{Deletion, DeletionPlan};
pub use worker::{TranscriptCursor, run_worker};

pub const CONTENT_SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

pub struct CodexAdapter {
    location: ProviderLocation,
    #[cfg(not(windows))]
    helper: PathBuf,
    #[cfg(not(windows))]
    home: PathBuf,
    connection: Mutex<Option<worker::Connection>>,
    deletion: Mutex<()>,
}

impl CodexAdapter {
    pub fn new(location: ProviderLocation, helper: PathBuf, home: PathBuf) -> Self {
        #[cfg(windows)]
        let _ = (helper, home);
        Self {
            location,
            #[cfg(not(windows))]
            helper,
            #[cfg(not(windows))]
            home,
            connection: Mutex::new(None),
            deletion: Mutex::new(()),
        }
    }

    pub fn detect(&self) -> Result<Installation, ProviderError> {
        validate_location(&self.location)?;
        let executable = self
            .location
            .executable
            .as_deref()
            .filter(|path| path.is_file());
        Ok(Installation {
            detected: executable.is_some(),
            version: executable
                .and_then(|path| process::probe_version(ProviderKind::Codex, path).ok()),
        })
    }
}

#[cfg(not(windows))]
struct Guard(Child);
#[cfg(not(windows))]
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
