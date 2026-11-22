//! Permanent removal of provider-scoped local Claude files.
mod history;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
use unix::{Object, names, unique_transcript};
#[cfg(windows)]
use windows::{Object, names, unique_transcript};

use crate::{ClaudeAdapter, SessionEvidence, artifacts::exact_sidecar, read::verify};
use agentmender_domain::SessionIdentity;
use serde::Serialize;
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Serialize, PartialEq, Eq)]
pub struct Target {
    #[serde(with = "agentmender_domain::path_serde")]
    root: PathBuf,
    #[serde(with = "agentmender_domain::path_serde")]
    relative_path: PathBuf,
    bytes: u64,
    #[serde(skip)]
    object: Object,
}

#[derive(Serialize, PartialEq, Eq)]
pub struct Plan {
    files: Vec<Target>,
    directories: Vec<Target>,
    logical_bytes: u64,
    history_matches: Option<usize>,
    notes: Vec<&'static str>,
    #[serde(skip)]
    uuid_scope: Option<UuidScope>,
}

#[derive(PartialEq, Eq)]
struct UuidScope {
    root: PathBuf,
    id: String,
    transcript: PathBuf,
    roots: Vec<PathBuf>,
    namespace_files: usize,
    namespace_directories: usize,
}

const AMBIGUOUS_UUID: &str =
    "Risorse per UUID preservate perché lo stesso ID potrebbe appartenere a più sessioni.";

fn uuid_is_unique<'a>(mut roots: impl Iterator<Item = &'a Path>, transcript: &Path) -> bool {
    roots.all(|root| unique_transcript(root, transcript).unwrap_or(false))
}

#[derive(Serialize, PartialEq, Eq)]
pub struct Outcome {
    pub removed_files: usize,
    pub removed_bytes: u64,
    pub history_rows: usize,
    pub errors: Vec<String>,
}

impl Plan {
    pub fn delete(mut self) -> Outcome {
        let mut uuid_scope = self.uuid_scope.take().filter(|scope| {
            if uuid_is_unique(scope.roots.iter().map(PathBuf::as_path), &scope.transcript) {
                return true;
            }
            self.files.truncate(scope.namespace_files);
            self.directories.truncate(scope.namespace_directories);
            self.notes.push(AMBIGUOUS_UUID);
            false
        });
        let mut outcome = Outcome {
            removed_files: 0,
            removed_bytes: 0,
            history_rows: 0,
            errors: self.notes.into_iter().map(str::to_owned).collect(),
        };
        let namespace_files = uuid_scope
            .as_ref()
            .map_or(self.files.len(), |scope| scope.namespace_files);
        let namespace_directories = uuid_scope
            .as_ref()
            .map_or(self.directories.len(), |scope| scope.namespace_directories);
        let mut recheck = |errors: &mut Vec<String>| {
            if uuid_scope.as_ref().is_some_and(|scope| {
                !uuid_is_unique(scope.roots.iter().map(PathBuf::as_path), &scope.transcript)
            }) {
                uuid_scope = None;
                errors.push(AMBIGUOUS_UUID.into());
            }
            uuid_scope.is_some()
        };
        let mut shared_files = true;
        for (index, target) in self.files.into_iter().enumerate() {
            if index == namespace_files {
                shared_files = recheck(&mut outcome.errors);
            }
            if index >= namespace_files && !shared_files {
                continue;
            }
            match target.delete() {
                Ok(bytes) => {
                    outcome.removed_files += 1;
                    outcome.removed_bytes += bytes;
                }
                Err(error) => {
                    outcome
                        .errors
                        .push(format!("{}: {error}", target.relative_path.display()));
                    if index == 0 {
                        return outcome;
                    }
                }
            }
        }
        let shared_directories =
            self.directories.len() > namespace_directories && recheck(&mut outcome.errors);
        for (index, target) in self.directories.into_iter().enumerate().rev() {
            if index >= namespace_directories && !shared_directories {
                continue;
            }
            if let Err(error) = target.delete()
                && error.kind() != io::ErrorKind::NotFound
            {
                outcome
                    .errors
                    .push(format!("{}: {error}", target.relative_path.display()));
            }
        }
        if recheck(&mut outcome.errors)
            && let Some(scope) = uuid_scope
        {
            match history::remove_rows(&scope.root, &scope.id) {
                Ok(count) => outcome.history_rows = count,
                Err(error) => outcome.errors.push(format!("history.jsonl: {error}")),
            }
        }
        outcome
    }
}

impl ClaudeAdapter {
    pub fn removal_plan(
        &self,
        identity: &SessionIdentity,
        evidence: &SessionEvidence,
    ) -> io::Result<Plan> {
        let root = &identity.state_root;
        let transcript = self
            .transcript_path(identity)
            .map_err(|_| io::ErrorKind::InvalidInput)?;
        verify(root, &transcript, &evidence.revision).map_err(|_| io::ErrorKind::InvalidData)?;
        let mut plan = Plan {
            files: Vec::new(),
            logical_bytes: 0,
            history_matches: None,
            notes: Vec::new(),
            directories: Vec::new(),
            uuid_scope: None,
        };
        plan.add_file(root, &transcript)?;
        verify(root, &transcript, &evidence.revision).map_err(|_| io::ErrorKind::InvalidData)?;
        let id = &identity.native_id;
        let namespace = transcript
            .parent()
            .expect("recognized transcript namespace");
        if let Err(error) = plan.sidecars(root, namespace, id) {
            plan.note_scan_error(error);
        }

        let protected_roots: Vec<_> = self
            .roots
            .iter()
            .map(|(path, _)| path.as_path())
            .chain(self.desktop_roots())
            .collect();
        plan.walk(root, &transcript.with_extension(""), &protected_roots);

        // Ownership of UUID-only files does not depend on diagnostic scan budgets.
        if uuid_is_unique(
            self.roots.iter().map(|(path, _)| path.as_path()),
            &transcript,
        ) {
            plan.uuid_scope = Some(UuidScope {
                root: root.clone(),
                id: id.clone(),
                transcript,
                roots: self.roots.iter().map(|(path, _)| path.clone()).collect(),
                namespace_files: plan.files.len(),
                namespace_directories: plan.directories.len(),
            });
            if let Some(desktop) = &evidence.desktop_artifact {
                if verify(&desktop.root, &desktop.path, &desktop.revision).is_ok() {
                    plan.candidate(&desktop.root, &desktop.path);
                } else {
                    plan.notes
                        .push("Registrazione Desktop cambiata o non leggibile.");
                }
            }
            for directory in ["session-env", "tasks", "file-history"] {
                plan.walk(root, &root.join(directory).join(id), &protected_roots);
            }
            plan.candidate(root, &root.join("debug").join(format!("{id}.txt")));
            plan.history_matches = history::count_rows(root, id).ok();
        } else {
            plan.notes.push(AMBIGUOUS_UUID);
        }
        Ok(plan)
    }
}

impl Plan {
    fn note_scan_error(&mut self, error: io::Error) {
        const NOTE: &str = "Alcune risorse associate sono protette o non leggibili.";
        if error.kind() != io::ErrorKind::NotFound && !self.notes.contains(&NOTE) {
            self.notes.push(NOTE);
        }
    }

    fn add_file(&mut self, root: &Path, path: &Path) -> io::Result<()> {
        let relative = relative_to(root, path)?;
        self.add(Target::new(
            root,
            relative,
            Object::inspect(root, relative, true)?,
        ));
        Ok(())
    }

    fn candidate(&mut self, root: &Path, path: &Path) {
        if let Err(error) = self.add_file(root, path) {
            self.note_scan_error(error);
        }
    }

    fn sidecars(&mut self, root: &Path, namespace: &Path, id: &str) -> io::Result<()> {
        let mut entries = names(root, relative_to(root, namespace)?)?;
        entries.sort_unstable();
        for name in entries {
            if name
                .to_str()
                .and_then(|name| name.strip_prefix(id))
                .is_some_and(exact_sidecar)
            {
                self.candidate(root, &namespace.join(name));
            }
        }
        Ok(())
    }

    fn add(&mut self, target: Target) {
        if target.object.directory {
            self.directories.push(target);
        } else {
            self.logical_bytes = self.logical_bytes.saturating_add(target.bytes);
            self.files.push(target);
        }
    }

    fn walk(&mut self, root: &Path, path: &Path, protected_roots: &[&Path]) {
        let mut pending = vec![path.to_owned()];
        while let Some(path) = pending.pop() {
            if protected_roots.contains(&path.as_path()) {
                self.note_scan_error(io::ErrorKind::PermissionDenied.into());
                continue;
            }
            if let Err(error) = self.visit(root, &path, &mut pending) {
                self.note_scan_error(error);
            }
        }
    }

    fn visit(&mut self, root: &Path, path: &Path, pending: &mut Vec<PathBuf>) -> io::Result<()> {
        let relative = relative_to(root, path)?;
        let object = Object::inspect(root, relative, false)?;
        let directory = object.directory;
        self.add(Target::new(root, relative, object));
        if directory {
            let mut entries = names(root, relative)?;
            entries.sort_unstable();
            pending.extend(entries.into_iter().rev().map(|name| path.join(name)));
        }
        Ok(())
    }
}

impl Target {
    fn new(root: &Path, relative: &Path, object: Object) -> Self {
        Self {
            root: root.to_owned(),
            relative_path: relative.to_owned(),
            bytes: object.bytes,
            object,
        }
    }

    fn delete(&self) -> io::Result<u64> {
        self.object.remove(&self.root, &self.relative_path)
    }
}

fn relative_to<'a>(root: &Path, path: &'a Path) -> io::Result<&'a Path> {
    path.strip_prefix(root)
        .map_err(|_| io::ErrorKind::InvalidInput.into())
}
