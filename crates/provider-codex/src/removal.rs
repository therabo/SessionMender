//! Confirmed Codex deletion uses native commands for the reviewed lineage.
use crate::{CodexAdapter, worker::LineageFact};
use agentmender_domain::{ProviderKind, SessionIdentity, canonical_uuid};
use agentmender_provider_api::process;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct DeletionPlan {
    #[serde(skip)]
    root: PathBuf,
    trees: Vec<Tree>,
    #[serde(skip)]
    protected: Vec<String>,
    #[cfg(windows)]
    #[serde(skip)]
    root_identity: agentmender_provider_api::filesystem::Identity,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct Tree {
    id: Uuid,
    descendants: Vec<Descendant>,
    #[serde(skip)]
    archived: bool,
    #[cfg(windows)]
    #[serde(skip)]
    rollouts: BTreeMap<Uuid, BTreeMap<PathBuf, String>>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct Descendant {
    id: Uuid,
    parent: Uuid,
    archived: bool,
    present: bool,
    depth: usize,
}

#[derive(Default)]
pub struct Deletion {
    pub native_succeeded: usize,
    pub verified_absent: usize,
    pub requested_absent: bool,
    pub messages: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Default)]
struct Node {
    parents: BTreeSet<Uuid>,
    present: bool,
    archived: bool,
    uncertain: bool,
    #[cfg(windows)]
    rollouts: BTreeMap<PathBuf, String>,
}

#[derive(Default)]
struct Archive {
    nodes: BTreeMap<Uuid, Node>,
    children: BTreeMap<Uuid, BTreeSet<Uuid>>,
}

impl Archive {
    fn from_facts(facts: Vec<LineageFact>) -> Self {
        let mut archive = Self::default();
        for fact in facts {
            match fact {
                LineageFact::Present { id, archived } => {
                    let node = archive.nodes.entry(id).or_default();
                    node.present = true;
                    node.archived |= archived;
                }
                LineageFact::Edge { parent, child } => {
                    archive
                        .nodes
                        .entry(child)
                        .or_default()
                        .parents
                        .insert(parent);
                    archive.children.entry(parent).or_default().insert(child);
                }
                LineageFact::Uncertain(id) => archive.nodes.entry(id).or_default().uncertain = true,
                #[cfg(windows)]
                LineageFact::Rollout { id, path, revision } => {
                    let node = archive.nodes.entry(id).or_default();
                    node.rollouts.insert(path, revision);
                    node.uncertain |= node.rollouts.len() > 1;
                }
            }
        }
        archive
    }

    fn present(&self, id: Uuid) -> bool {
        self.nodes
            .get(&id)
            .is_some_and(|node| node.present || node.uncertain)
    }

    fn tree(&self, id: Uuid, protected: &BTreeSet<Uuid>) -> Result<Tree, String> {
        let root = self
            .nodes
            .get(&id)
            .ok_or("The Codex session is no longer present.")?;
        if !root.present || root.uncertain || !root.parents.is_empty() {
            return Err(format!(
                "{id}: Codex session identity or relationship could not be verified."
            ));
        }

        let mut descendants = Vec::new();
        let mut pending = vec![(id, 0)];
        let mut seen = BTreeSet::from([id]);
        let mut offset = 0;
        while let Some(&(parent, depth)) = pending.get(offset) {
            offset += 1;
            if protected.contains(&parent) {
                return Err(format!(
                    "{parent}: session protected by the launch configuration."
                ));
            }
            for &child in self.children.get(&parent).into_iter().flatten() {
                let node = &self.nodes[&child];
                if !seen.insert(child) || node.parents.len() != 1 || node.uncertain {
                    return Err(format!(
                        "{child}: Codex descendant relationships are ambiguous or cyclic."
                    ));
                }
                descendants.push(Descendant {
                    id: child,
                    parent,
                    archived: node.archived,
                    present: node.present,
                    depth: depth + 1,
                });
                pending.push((child, depth + 1));
            }
        }
        Ok(Tree {
            id,
            archived: root.archived,
            #[cfg(windows)]
            rollouts: seen
                .into_iter()
                .map(|id| (id, self.nodes[&id].rollouts.clone()))
                .collect(),
            descendants,
        })
    }

    fn rollout_changed(&self, node: &Node, tree: &Tree, id: Uuid) -> bool {
        #[cfg(windows)]
        return node.rollouts.iter().any(|(path, revision)| {
            tree.rollouts.get(&id).and_then(|entries| entries.get(path)) != Some(revision)
        });
        #[cfg(not(windows))]
        {
            let _ = (node, tree, id);
            false
        }
    }

    // A reviewed node can still be addressed if native deletion already erased
    // its inbound edge. A new parent or unreviewed child makes another native
    // call unsafe because the command may operate on descendants as well.
    fn blocked_writes(&self, tree: &Tree, changes: &mut BTreeSet<String>) -> BTreeSet<Uuid> {
        let reviewed: BTreeMap<_, _> = std::iter::once((tree.id, (None, true)))
            .chain(
                tree.descendants
                    .iter()
                    .map(|child| (child.id, (Some(child.parent), child.present))),
            )
            .collect();
        let mut blocked = BTreeSet::new();
        for (&id, &(parent, was_present)) in &reviewed {
            if self.nodes.get(&id).is_some_and(|node| {
                node.uncertain
                    || (!was_present && node.present)
                    || node.parents.iter().any(|found| Some(*found) != parent)
                    || self.rollout_changed(node, tree, id)
            }) {
                blocked.insert(id);
                changes.insert(format!(
                    "{id}: the relationship or presence changed after the review."
                ));
            }

            for &child in self.children.get(&id).into_iter().flatten() {
                if reviewed.get(&child).is_none_or(|&(expected, was_present)| {
                    expected != Some(id) || (!was_present && self.present(child))
                }) {
                    blocked.insert(id);
                    changes.insert(format!(
                        "{id}: descendant {child} is outside the confirmed plan."
                    ));
                }
            }
        }
        for child in tree.descendants.iter().rev() {
            if blocked.contains(&child.id)
                && self
                    .children
                    .get(&child.parent)
                    .is_some_and(|ids| ids.contains(&child.id))
            {
                blocked.insert(child.parent);
            }
        }
        blocked
    }
}

impl CodexAdapter {
    fn archive(&self) -> Result<Archive, String> {
        self.lineage()
            .map(Archive::from_facts)
            .map_err(|error| format!("The Codex graph or archive could not be verified: {error}"))
    }

    fn selected_root(&self) -> Result<PathBuf, String> {
        #[cfg(windows)]
        return crate::discovery::verified_read_root(&self.location.state_root)
            .map_err(|error| error.to_string());
        #[cfg(not(windows))]
        self.location
            .state_root
            .canonicalize()
            .map_err(|error| format!("The Codex archive is unavailable: {error}"))
    }

    pub fn deletion_plan(
        &self,
        sessions: &[SessionIdentity],
        protected: &[String],
    ) -> Result<DeletionPlan, String> {
        let root = self.selected_root()?;
        #[cfg(windows)]
        let directory = agentmender_provider_api::filesystem::Directory::open(&root)
            .map_err(|error| error.to_string())?;
        let ids = sessions
            .iter()
            .map(|identity| {
                if identity.provider != ProviderKind::Codex
                    || identity.state_root != root
                    || identity.namespace.is_some()
                    || !canonical_uuid(&identity.native_id)
                {
                    return Err("The session does not belong to the Codex archive.".to_owned());
                }
                Uuid::parse_str(&identity.native_id).map_err(|_| "Invalid Codex UUID.".into())
            })
            .collect::<Result<Vec<_>, String>>()?;
        if ids.is_empty() {
            return Err("No Codex sessions to delete.".into());
        }
        let archive = self.archive()?;
        let protected_ids = protected
            .iter()
            .filter_map(|id| Uuid::parse_str(id).ok())
            .collect();
        let trees = ids
            .into_iter()
            .map(|id| archive.tree(id, &protected_ids))
            .collect::<Result<_, _>>()?;
        Ok(DeletionPlan {
            root,
            trees,
            protected: protected.to_vec(),
            #[cfg(windows)]
            root_identity: directory.item().identity,
        })
    }

    pub fn native_removal_reason(&self) -> Option<&'static str> {
        #[cfg(not(any(target_os = "macos", windows)))]
        return Some("Codex removal is unavailable on this platform.");
        #[cfg(any(target_os = "macos", windows))]
        {
            let Some(executable) = self
                .location
                .executable
                .as_ref()
                .filter(|path| path.is_file())
            else {
                return Some("The Codex executable is unavailable.");
            };
            #[cfg(windows)]
            if process::codex_delete_version(executable).is_err() {
                return Some(
                    "The Codex CLI version or delete --force command could not be verified.",
                );
            }
            #[cfg(target_os = "macos")]
            let _ = executable;
            None
        }
    }

    pub fn delete_reviewed(&self, plan: DeletionPlan) -> Result<Deletion, String> {
        let _deletion = self
            .deletion
            .lock()
            .map_err(|_| "Codex removal is unavailable.")?;
        if let Some(reason) = self.native_removal_reason() {
            return Err(reason.into());
        }
        #[cfg(windows)]
        let _directory = agentmender_provider_api::filesystem::Directory::open(&plan.root)
            .map_err(|error| error.to_string())?;
        let identities: Vec<_> = plan
            .trees
            .iter()
            .map(|tree| SessionIdentity {
                provider: ProviderKind::Codex,
                state_root: plan.root.clone(),
                namespace: None,
                native_id: tree.id.to_string(),
            })
            .collect();
        if self.deletion_plan(&identities, &plan.protected)? != plan {
            return Err(
                "The archive or session relationships have changed. Open a new Codex removal review.".into(),
            );
        }
        let executable = self
            .location
            .executable
            .as_deref()
            .ok_or("The Codex executable is unavailable.")?;
        let path = plan
            .root
            .to_str()
            .ok_or("The Codex archive path cannot be represented.")?;
        let setting = format!("sqlite_home={}", toml::Value::String(path.to_owned()));
        let native = |id| process::codex_delete(executable, &plan.root, &setting, id);
        Ok(delete(&plan, native, || {
            if self.selected_root()? != plan.root {
                return Err(
                    "The Codex archive has changed. Deletion could not be verified.".into(),
                );
            }
            self.archive()
        }))
    }

    /// Repair Desktop projections for explicitly selected, already absent UUIDs.
    #[cfg(windows)]
    pub fn reconcile_removed_desktop_sessions(
        &self,
        ids: &[String],
        protected: &[String],
    ) -> Result<(), String> {
        let _deletion = self
            .deletion
            .lock()
            .map_err(|_| "Codex reconciliation is unavailable.")?;
        let root = self.selected_root()?;
        let _directory = agentmender_provider_api::filesystem::Directory::open(&root)
            .map_err(|error| error.to_string())?;
        let ids: BTreeSet<_> = ids.iter().collect();
        if ids.is_empty() {
            return Err("Specify at least one Codex UUID to reconcile.".into());
        }
        let archive = self.archive()?;
        for &id in &ids {
            if !canonical_uuid(id) {
                return Err("Invalid Codex UUID.".into());
            }
            let uuid = Uuid::parse_str(id).map_err(|error| error.to_string())?;
            if protected.contains(id) || archive.present(uuid) {
                return Err(format!(
                    "{id}: the session is protected, still present, or could not be verified."
                ));
            }
        }
        let mut errors = Vec::new();
        for id in ids {
            let mut failures = Vec::new();
            crate::desktop_reconciliation::remove_local_thread(&root, id, &mut failures);
            errors.extend(failures.into_iter().map(|error| format!("{id}: {error}")));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("\n"))
        }
    }
}

fn waiting_for_children(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("cannot delete")
        && ["attached thread", "child thread", "linked child"]
            .iter()
            .any(|reason| error.contains(reason))
}

fn delete(
    plan: &DeletionPlan,
    native: impl Fn(Uuid) -> Result<String, String>,
    observe: impl Fn() -> Result<Archive, String>,
) -> Deletion {
    let mut outcome = Deletion::default();
    let mut targets = BTreeSet::new();
    let mut changes = BTreeSet::new();
    let mut messages = BTreeMap::new();
    let mut archive = observe().map_err(|error| outcome.errors.push(error)).ok();
    for tree in &plan.trees {
        let Some(current) = archive.as_ref() else {
            break;
        };
        if current.tree(tree.id, &BTreeSet::new()).ok().as_ref() != Some(tree) {
            outcome.errors.push(format!(
                "{}: the session or its descendants changed after the review.",
                tree.id
            ));
            break;
        }
        targets.insert(tree.id);
        targets.extend(
            tree.descendants
                .iter()
                .filter(|child| child.present)
                .map(|child| child.id),
        );
        let removal = run_native(tree.id, &native, &observe, &mut outcome, &mut archive);
        let refusal = match removal {
            Ok(message) => {
                messages.insert(tree.id, message);
                None
            }
            Err(error)
                if waiting_for_children(&error)
                    && tree.descendants.iter().any(|child| child.present) =>
            {
                Some(error)
            }
            Err(error) => {
                outcome.errors.push(format!("{}: {error}", tree.id));
                break;
            }
        };
        for child in tree.descendants.iter().rev().filter(|child| child.present) {
            let Some(current) = archive.as_ref() else {
                break;
            };
            let blocked = current.blocked_writes(tree, &mut changes);
            if current.present(child.id)
                && !blocked.contains(&child.id)
                && let Err(error) =
                    run_native(child.id, &native, &observe, &mut outcome, &mut archive)
            {
                outcome.errors.push(format!("{}: {error}", child.id));
            }
        }
        if let Some(error) = refusal {
            match archive.as_ref() {
                Some(current) if !current.present(tree.id) => {}
                Some(current)
                    if !current
                        .blocked_writes(tree, &mut changes)
                        .contains(&tree.id)
                        && tree
                            .descendants
                            .iter()
                            .all(|child| !current.present(child.id)) =>
                {
                    match run_native(tree.id, &native, &observe, &mut outcome, &mut archive) {
                        Ok(message) => {
                            messages.insert(tree.id, message);
                        }
                        Err(error) => outcome.errors.push(format!("{}: {error}", tree.id)),
                    }
                }
                _ => outcome.errors.push(format!("{}: {error}", tree.id)),
            }
        }
    }
    outcome.errors.extend(changes);
    if let Some(current) = archive {
        outcome.requested_absent = plan.trees.iter().all(|tree| !current.present(tree.id));
        for id in targets {
            if current.present(id) {
                let reason = if current.nodes.get(&id).is_some_and(|node| node.uncertain) {
                    "session presence could not be verified"
                } else {
                    "session is still present in the Codex archive"
                };
                outcome.errors.push(format!("{id}: {reason}."));
                continue;
            }
            outcome.verified_absent += 1;
            if let Some(message) = messages.remove(&id) {
                outcome.messages.push(message);
            }
            cleanup(&plan.root, id, &mut outcome);
        }
    }
    outcome
}

fn run_native(
    id: Uuid,
    native: &impl Fn(Uuid) -> Result<String, String>,
    observe: &impl Fn() -> Result<Archive, String>,
    outcome: &mut Deletion,
    archive: &mut Option<Archive>,
) -> Result<String, String> {
    let result = native(id);
    outcome.native_succeeded += usize::from(result.is_ok());
    *archive = observe().map_err(|error| outcome.errors.push(error)).ok();
    result
}

fn cleanup(root: &Path, id: Uuid, outcome: &mut Deletion) {
    #[cfg(any(target_os = "macos", windows))]
    outcome.errors.extend(
        crate::cleanup::after_native_delete(root, id)
            .into_iter()
            .map(|error| format!("{id}: additional cleanup was incomplete. {error}")),
    );
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (root, id, outcome);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protection_covers_archived_descendants_and_rejects_ambiguous_parents() {
        let root = Uuid::from_u128(1);
        let child = Uuid::from_u128(2);
        let parent = Uuid::from_u128(3);
        let facts = vec![
            LineageFact::Present {
                id: root,
                archived: false,
            },
            LineageFact::Present {
                id: child,
                archived: true,
            },
            LineageFact::Edge {
                parent: root,
                child,
            },
        ];
        let archive = Archive::from_facts(facts.clone());
        let tree = archive
            .tree(root, &BTreeSet::new())
            .expect("verified descendant");
        assert_eq!(tree.descendants[0].id, child);
        assert!(tree.descendants[0].archived);
        assert!(archive.tree(root, &BTreeSet::from([child])).is_err());
        let ambiguous = Archive::from_facts(
            facts
                .into_iter()
                .chain([LineageFact::Edge { parent, child }])
                .collect(),
        );
        assert!(ambiguous.tree(root, &BTreeSet::new()).is_err());
    }
}
