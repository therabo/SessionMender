//! Bounded provider discovery. Evidence of location does not authorize mutation.
mod platform;

use agentmender_domain::{ProviderKind, canonical_uuid};
use agentmender_provider_api::{ProviderLocation, filesystem, process};
#[cfg(not(any(unix, windows)))]
use same_file::Handle;
use serde::Deserialize;
use std::{
    collections::{BTreeSet, hash_map::DefaultHasher},
    env, fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageKind {
    Home,
    Sessions,
    ArchivedSessions,
    StateDatabase,
    HistoryDatabase,
    DesktopCatalog,
    ExportCandidate,
    ArtifactSessionExports,
    ExternalExports,
    WorkspaceExports,
    Attachments,
    GeneratedImages,
    Cache,
    Logs,
    Worktrees,
    UserOutput,
    DesktopProfile,
}

impl StorageKind {
    pub(crate) fn is_export(self) -> bool {
        matches!(
            self,
            Self::ExportCandidate
                | Self::ArtifactSessionExports
                | Self::ExternalExports
                | Self::WorkspaceExports
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Access {
    Accessible,
    Unavailable,
    Linked,
    NetworkPath,
}

#[derive(Clone, Debug)]
pub struct Storage {
    pub kind: StorageKind,
    pub path: PathBuf,
    pub identity: Option<String>,
    pub observed: bool,
    pub recognized: bool,
    pub owned: bool,
    pub access: Access,
    pub inventory_available: bool,
}

struct Installation {
    kind: &'static str,
    version: Option<String>,
    executable: Option<PathBuf>,
}

pub struct Discovery {
    pub selected_root: PathBuf,
    pub storage: Vec<Storage>,
    pub location: ProviderLocation,
}

#[derive(Default, Deserialize)]
struct Settings {
    sqlite_home: Option<PathBuf>,
    log_dir: Option<PathBuf>,
    desktop: Option<DesktopSettings>,
}

#[derive(Default, Deserialize)]
struct DesktopSettings {
    #[serde(rename = "git-worktree-root")]
    worktree_root: Option<PathBuf>,
    #[serde(rename = "workspace-root")]
    workspace_root: Option<PathBuf>,
}

fn absolute(path: Option<PathBuf>) -> Option<PathBuf> {
    path.filter(|path| path.is_absolute())
}

fn environment(name: &str) -> Option<PathBuf> {
    absolute(env::var_os(name).map(PathBuf::from))
}

fn network_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..) | Prefix::DeviceNS(..)))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

pub(crate) fn access(path: &Path) -> Access {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
    {
        return Access::Unavailable;
    }
    if network_path(path) {
        return Access::NetworkPath;
    }
    // A junction or symlink at any component can redirect a lookup into an
    // unrelated profile. Stock macOS /var and /tmp system aliases are handled
    // by supplying the canonical archive path.
    for part in path
        .ancestors()
        .filter(|part| part.is_absolute())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        match fs::symlink_metadata(part) {
            Ok(meta) if filesystem::is_link(&meta) => return Access::Linked,
            Ok(_) => {}
            Err(_) => return Access::Unavailable,
        }
    }
    Access::Accessible
}

pub(crate) fn identity(path: &Path) -> Option<String> {
    if access(path) != Access::Accessible {
        return None;
    }
    let mut hash = DefaultHasher::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let info = fs::symlink_metadata(path).ok()?;
        (info.dev(), info.ino()).hash(&mut hash);
    }
    #[cfg(windows)]
    {
        let object = match path.parent() {
            Some(parent) => filesystem::Directory::open(parent)
                .ok()?
                .inspect(path)
                .ok()?,
            None => filesystem::Directory::open(path).ok()?.item(),
        };
        (object.identity.volume, object.identity.id).hash(&mut hash);
    }
    #[cfg(not(any(unix, windows)))]
    Handle::from_path(path).ok()?.hash(&mut hash);
    Some(format!("{:016x}", hash.finish()))
}

fn settings(root: &Path) -> Settings {
    let path = root.join("config.toml");
    if access(&path) != Access::Accessible {
        return Settings::default();
    }
    filesystem::read_bounded(root, &path, 256 * 1024)
        .ok()
        .and_then(|bytes| toml::from_str::<Settings>(std::str::from_utf8(&bytes).ok()?).ok())
        .unwrap_or_default()
}

#[cfg(any(target_os = "linux", windows))]
pub(crate) fn verified_read_root(
    root: &Path,
) -> Result<PathBuf, agentmender_provider_api::ProviderError> {
    use agentmender_provider_api::ProviderError;
    #[cfg(windows)]
    let directory = filesystem::Directory::open(root).map_err(|error| {
        ProviderError::CapabilityUnavailable(format!(
            "local Codex root could not be verified: {error}"
        ))
    })?;
    #[cfg(windows)]
    let path = directory.path();
    #[cfg(target_os = "linux")]
    let canonical = {
        let canonical = root
            .canonicalize()
            .map_err(|error| agentmender_provider_api::io_error(root, error))?;
        if canonical != root || access(root) != Access::Accessible || !root.is_dir() {
            return Err(ProviderError::CapabilityUnavailable(
                "local Codex root could not be verified".into(),
            ));
        }
        canonical
    };
    #[cfg(target_os = "linux")]
    let path = canonical.as_path();
    let config = path.join("config.toml");
    let configured = match filesystem::open_source_read(path, &config) {
        Ok(file) => {
            use std::io::Read;
            const CONFIG_LIMIT: u64 = 256 * 1024;
            let mut bytes = Vec::new();
            file.take(CONFIG_LIMIT + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| agentmender_provider_api::io_error(&config, error))?;
            if bytes.len() as u64 > CONFIG_LIMIT {
                return Err(ProviderError::CapabilityUnavailable(
                    "Codex config.toml exceeds the read limit".into(),
                ));
            }
            let text = std::str::from_utf8(&bytes).map_err(|_| {
                ProviderError::CapabilityUnavailable("Codex config.toml is unreadable".into())
            })?;
            toml::from_str::<Settings>(text)
                .map_err(|_| {
                    ProviderError::CapabilityUnavailable("Codex config.toml is unrecognized".into())
                })?
                .sqlite_home
        }
        Err(ProviderError::CapabilityUnavailable(reason)) if reason == "source file missing" => {
            None
        }
        Err(error) => return Err(error),
    };
    if let Some(sqlite_home) =
        configured.or_else(|| env::var_os("CODEX_SQLITE_HOME").map(PathBuf::from))
    {
        #[cfg(windows)]
        let same_root = filesystem::Directory::open(&sqlite_home)
            .is_ok_and(|sqlite| sqlite.item().identity == directory.item().identity);
        #[cfg(target_os = "linux")]
        let same_root = access(&sqlite_home) == Access::Accessible
            && sqlite_home
                .canonicalize()
                .is_ok_and(|sqlite| sqlite == path);
        if !same_root {
            return Err(ProviderError::CapabilityUnavailable(
                "the separate sqlite_home database could not be verified as part of this archive"
                    .into(),
            ));
        }
    }
    Ok(path.to_owned())
}

fn archive_format(root: &Path) -> bool {
    let path = root.join("state_5.sqlite");
    if access(&path) != Access::Accessible {
        return false;
    }
    filesystem::read_prefix(root, &path, 16).is_ok_and(|bytes| bytes == b"SQLite format 3\0")
}

fn provider_marker(root: &Path) -> bool {
    #[derive(Deserialize)]
    struct IndexEntry {
        id: String,
    }
    let index = root.join("session_index.jsonl");
    if access(&index) == Access::Accessible
        && let Ok(bytes) = filesystem::read_prefix(root, &index, 8192)
        && let Some(end) = bytes.iter().position(|byte| *byte == b'\n')
        && serde_json::from_slice::<IndexEntry>(&bytes[..end])
            .is_ok_and(|entry| canonical_uuid(&entry.id))
    {
        return true;
    }
    let desktop = root.join(".codex-global-state.json");
    access(&desktop) == Access::Accessible
        && filesystem::read_bounded(root, &desktop, 2 * 1024 * 1024)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|value| {
                value.get("local-projects").is_some()
                    || value.get("thread-project-assignments").is_some()
            })
}

fn row(kind: StorageKind, path: PathBuf, recognized: bool, owned: bool) -> Storage {
    let access = access(&path);
    let observed = access == Access::Accessible
        || access == Access::Linked
            && path
                .parent()
                .is_some_and(|parent| self::access(parent) == Access::Accessible);
    Storage {
        kind,
        identity: (access == Access::Accessible)
            .then(|| identity(&path))
            .flatten(),
        path,
        observed,
        recognized,
        owned,
        access,
        inventory_available: access == Access::Accessible && kind.is_export(),
    }
}

impl Discovery {
    /// Launch selection is deterministic. Additional roots stay distinct in
    /// Storage and are never attached to the selected session writer.
    pub fn detect(
        home: &Path,
        root_override: Option<PathBuf>,
        executable_override: Option<PathBuf>,
    ) -> Result<Self, &'static str> {
        let configured = env::var_os("CODEX_HOME").map(PathBuf::from);
        let platform_archives = platform::archive_candidates(home);
        let default = home.join(".codex");
        let mut recognized_alternatives = platform_archives
            .iter()
            .filter(|path| archive_format(path) && provider_marker(path));
        let selected = if let Some(root) = root_override {
            root
        } else if let Some(root) = configured.as_ref() {
            root.clone()
        } else if access(&default) == Access::Unavailable
            && let Some(alternative) = recognized_alternatives.next()
            && recognized_alternatives.next().is_none()
        {
            alternative.clone()
        } else {
            default.clone()
        };
        if !selected.is_absolute() {
            return Err("CODEX_HOME must be an absolute path.");
        }
        let homes = std::iter::once((selected.clone(), true, false))
            .chain(absolute(configured).map(|path| (path, false, false)))
            .chain([(default, false, false)])
            .chain(
                platform_archives
                    .into_iter()
                    .map(|path| (path, false, true)),
            );
        let mut seen = BTreeSet::new();
        let mut storage = Vec::new();
        #[cfg(windows)]
        let mut workspace_exports = Vec::new();
        for (archive_root, primary, requires_provider_marker) in homes {
            let user_home = home;
            let home = archive_root;
            if network_path(&home) && !primary {
                continue;
            }
            let key = identity(&home).unwrap_or_else(|| home.to_string_lossy().into_owned());
            if !seen.insert(key)
                || !primary && !archive_format(&home)
                || requires_provider_marker && !provider_marker(&home)
            {
                continue;
            }
            let mut settings = settings(&home);
            let configured_sqlite = absolute(settings.sqlite_home.take());
            let sqlite = configured_sqlite
                .as_ref()
                .cloned()
                .or_else(|| primary.then(|| environment("CODEX_SQLITE_HOME")).flatten())
                .unwrap_or_else(|| home.clone());
            let recognized = archive_format(&sqlite);
            let owned = recognized && provider_marker(&home);
            storage.push(row(StorageKind::Home, home.clone(), recognized, owned));
            for (kind, name) in [
                (StorageKind::Sessions, "sessions"),
                (StorageKind::ArchivedSessions, "archived_sessions"),
                (StorageKind::DesktopCatalog, "sqlite"),
                (StorageKind::ExportCandidate, "exports"),
                (StorageKind::Attachments, "attachments"),
                (StorageKind::GeneratedImages, "generated_images"),
                (StorageKind::Cache, "cache"),
            ] {
                let path = home.join(name);
                let provider_layout = recognized && kind != StorageKind::ExportCandidate;
                let observation = row(kind, path, provider_layout, provider_layout && owned);
                if observation.observed {
                    storage.push(observation);
                }
            }
            for (kind, name) in [
                (StorageKind::StateDatabase, "state_5.sqlite"),
                (StorageKind::HistoryDatabase, "thread_history_1.sqlite"),
            ] {
                let observation = row(kind, sqlite.join(name), recognized, owned);
                if observation.observed || kind == StorageKind::StateDatabase && sqlite != home {
                    storage.push(observation);
                }
            }
            let logs = absolute(settings.log_dir).unwrap_or_else(|| home.join("log"));
            if network_path(&logs) || fs::symlink_metadata(&logs).is_ok() {
                storage.push(row(StorageKind::Logs, logs, recognized, recognized));
            }
            let desktop = settings.desktop.unwrap_or_default();
            let workspace = absolute(desktop.workspace_root)
                .unwrap_or_else(|| platform::user_output(user_home));
            #[cfg(windows)]
            if primary {
                workspace_exports.extend(platform::workspace_exports(&workspace).filter(|item| {
                    // Apply the same boundary as an explicit external export root.
                    // Compare identities as well for Windows aliases and casing.
                    [selected.as_path(), user_home]
                        .into_iter()
                        .all(|protected| {
                            !protected.starts_with(&item.path)
                                && !protected.ancestors().any(|ancestor| {
                                    identity(ancestor).as_ref() == item.identity.as_ref()
                                })
                        })
                }));
            }
            for (kind, path) in [
                (
                    StorageKind::Worktrees,
                    absolute(desktop.worktree_root).unwrap_or_else(|| home.join("worktrees")),
                ),
                (StorageKind::UserOutput, workspace),
            ] {
                let observation = row(
                    kind,
                    path,
                    recognized && kind == StorageKind::Worktrees,
                    false,
                );
                if observation.observed || observation.access == Access::NetworkPath {
                    storage.push(observation);
                }
            }
        }

        let (mut installations, desktop_storage) = platform::desktop(home);
        storage.extend(desktop_storage);
        #[cfg(windows)]
        storage.extend(workspace_exports);
        if let Some(path) = environment("ARTIFACT_SESSION_HOST_EXPORT_ROOT") {
            let mut external = row(StorageKind::ExternalExports, path, false, false);
            if selected.starts_with(&external.path) || home.starts_with(&external.path) {
                external.inventory_available = false;
            }
            storage.insert(0, external);
        }
        let candidates = executable_override
            .iter()
            .cloned()
            .chain(process::find_executables(ProviderKind::Codex))
            .chain(platform::cli_candidates(home));
        let mut seen_paths = BTreeSet::new();
        for mut candidate in candidates.take(32) {
            if network_path(&candidate) {
                continue;
            }
            if let Ok(path) = candidate.canonicalize() {
                candidate = path;
            }
            if !seen_paths.insert(candidate.clone()) || !candidate.is_file() {
                continue;
            }
            let version = if seen_paths.len() <= 3 {
                process::probe_version(ProviderKind::Codex, &candidate).ok()
            } else {
                None
            };
            installations.push(Installation {
                kind: "cli",
                version,
                executable: Some(candidate),
            });
        }
        let executable = executable_override.or_else(|| {
            installations
                .iter()
                .find(|item| item.kind == "cli" && item.version.is_some())
                .or_else(|| installations.iter().find(|item| item.executable.is_some()))
                .and_then(|item| item.executable.clone())
        });
        Ok(Self {
            selected_root: selected.clone(),
            storage,
            location: ProviderLocation {
                state_root: selected,
                executable,
            },
        })
    }

    pub fn selected_access(&self) -> Access {
        access(&self.selected_root)
    }

    pub fn inspect_exports(&self) -> crate::exports::Inventory {
        crate::exports::Inventory::scan(&self.storage)
    }
}
