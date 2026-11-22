//! Explicit session deletion through the existing loopback authorization.
use super::{ApiError, App, inventory::ProjectView, provider, read};
use agentmender_domain::{ProviderKind, Session, SessionIdentity};
use agentmender_provider_codex::{Deletion, DeletionPlan};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) const REVIEW_AGE: Duration = Duration::from_secs(120);

pub(super) const PROTECTED: &str = "La sessione è protetta dalla configurazione di avvio.";

pub(super) fn native_reason(app: &App) -> Option<&'static str> {
    app.codex_native_reason
}

pub(super) fn refusal(session: &Session, protected: &[String]) -> Option<&'static str> {
    (session.identity.provider == ProviderKind::Codex
        && protected.contains(&session.identity.native_id))
    .then_some(PROTECTED)
}

pub(super) struct CodexReview {
    id: String,
    key: String,
    project: bool,
    plan: DeletionPlan,
    sessions: Vec<SessionIdentity>,
    expires: Instant,
}

fn codex_review(
    app: &App,
    key: String,
    project: bool,
    sessions: &[SessionIdentity],
) -> Result<serde_json::Value, ApiError> {
    if let Some(reason) = native_reason(app) {
        return Err(ApiError::conflict(reason));
    }
    let plan = app
        .codex
        .deletion_plan(sessions, &app.protected)
        .map_err(ApiError::conflict)?;
    let id = super::token()?;
    let view = serde_json::json!({ "review": id, "plan": &plan });
    *app.codex_review.lock().expect("Codex review") = Some(CodexReview {
        id,
        key,
        project,
        plan,
        sessions: sessions.to_vec(),
        expires: Instant::now() + REVIEW_AGE,
    });
    Ok(view)
}

pub(super) async fn codex_session_preview(
    State(app): State<Arc<App>>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    read(app, move |app| {
        let session = app.inventory.selected(app, ProviderKind::Codex, &key)?;
        if let Some(reason) = refusal(&session, &app.protected) {
            return Err(ApiError::conflict(reason));
        }
        codex_review(app, key, false, &[session.identity])
    })
    .await
}

pub(super) async fn codex_project_preview(
    State(app): State<Arc<App>>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    read(app, move |app| {
        let sessions = project_members(app, &key)?;
        codex_review(app, key, true, &sessions)
    })
    .await
}

fn project_members(app: &App, key: &str) -> Result<Vec<SessionIdentity>, ApiError> {
    app.inventory
        .project(app, ProviderKind::Codex, key, |app, _, project| {
            if let Some(reason) = ProjectView::new(app, project).removal_reason {
                return Err(ApiError::conflict(reason));
            }
            Ok(project
                .sessions
                .sessions()
                .map(|row| row.identity.clone())
                .collect::<Vec<_>>())
        })?
}

fn confirm_codex(
    app: &App,
    key: String,
    project: bool,
    review: Option<String>,
) -> Result<ResultView, ApiError> {
    let review = app
        .codex_review
        .lock()
        .expect("Codex review")
        .take_if(|plan| {
            plan.key == key && plan.project == project && Some(&plan.id) == review.as_ref()
        })
        .ok_or_else(|| ApiError::conflict("Apri una nuova anteprima Codex."))?;
    if review.expires <= Instant::now() {
        return Err(ApiError::conflict("Anteprima Codex scaduta."));
    }
    if project {
        app.inventory.invalidate(ProviderKind::Codex);
        let current = project_members(app, &key)?;
        let mut reviewed = review.sessions;
        let mut current = current;
        reviewed.sort();
        current.sort();
        if reviewed != current {
            return Err(ApiError::conflict(
                "Le sessioni del progetto sono cambiate. Apri una nuova anteprima.",
            ));
        }
    }
    let Deletion {
        native_succeeded,
        verified_absent,
        requested_absent,
        messages,
        errors,
    } = app
        .codex
        .delete_reviewed(review.plan)
        .map_err(ApiError::conflict)?;
    let mut message = format!(
        "Comandi nativi riusciti · {native_succeeded}. UUID verificati assenti · {verified_absent}."
    );
    if !errors.is_empty() && (native_succeeded > 0 || verified_absent > 0) {
        message.push_str(" Operazione incompleta.");
    }
    if !project && let Some(detail) = messages.first() {
        message.push(' ');
        message.push_str(detail);
    }
    let mut view = result(verified_absent, message, errors);
    view.codex_counts = Some(CodexCounts {
        native_succeeded,
        verified_absent,
        requested_absent,
    });
    Ok(view)
}

#[cfg(any(target_os = "macos", windows))]
pub(super) struct ClaudeReview {
    id: String,
    key: String,
    plan: agentmender_provider_claude::cleanup::Plan,
    expires: Instant,
}

#[cfg(any(target_os = "macos", windows))]
pub(super) async fn claude_preview(
    State(app): State<Arc<App>>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    read(app, move |app| {
        let (session, evidence) = app.inventory.selected_claude(app, &key)?;
        let plan = app
            .claude
            .removal_plan(&session.identity, &evidence)
            .map_err(|_| {
                ApiError::conflict(
                    "Transcript Claude cambiato o non leggibile. Aggiorna l’inventario.",
                )
            })?;
        let id = super::token()?;
        let view = serde_json::json!({ "review": id, "plan": &plan });
        *app.claude_review.lock().expect("Claude review") = Some(ClaudeReview {
            id,
            key,
            plan,
            expires: Instant::now() + REVIEW_AGE,
        });
        Ok(view)
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Confirmation {
    confirm: bool,
    review: Option<String>,
}

#[derive(Serialize)]
pub(super) struct ResultView {
    status: &'static str,
    message: String,
    errors: Vec<String>,
    #[serde(flatten)]
    codex_counts: Option<CodexCounts>,
}

#[derive(Serialize)]
struct CodexCounts {
    native_succeeded: usize,
    verified_absent: usize,
    requested_absent: bool,
}

fn result(removed: usize, message: String, errors: Vec<String>) -> ResultView {
    ResultView {
        status: if errors.is_empty() {
            "deleted"
        } else if removed > 0 {
            "partial"
        } else {
            "failed"
        },
        message,
        errors,
        codex_counts: None,
    }
}

pub(super) async fn session(
    State(app): State<Arc<App>>,
    Path((name, key)): Path<(String, String)>,
    Json(request): Json<Confirmation>,
) -> Result<Json<ResultView>, ApiError> {
    if !request.confirm {
        return Err(ApiError::bad("Conferma l’eliminazione definitiva."));
    }
    let provider = provider(&name)?;
    read(app, move |app| {
        let _mutation = app.mutations.lock().map_err(|_| ApiError::internal())?;
        let outcome = match provider {
            ProviderKind::Codex => confirm_codex(app, key, false, request.review)?,
            ProviderKind::Claude => {
                #[cfg(any(target_os = "macos", windows))]
                {
                    let review = {
                        let mut slot = app.claude_review.lock().expect("Claude review");
                        slot.take_if(|plan| {
                            plan.key == key && Some(&plan.id) == request.review.as_ref()
                        })
                        .ok_or_else(|| ApiError::conflict("Apri una nuova anteprima Claude."))?
                    };
                    if review.expires <= Instant::now() {
                        return Err(ApiError::conflict("Anteprima Claude scaduta."));
                    }
                    app.inventory.invalidate(ProviderKind::Claude);
                    let (session, evidence) = app.inventory.selected_claude(app, &key)?;
                    let current = app
                        .claude
                        .removal_plan(&session.identity, &evidence)
                        .map_err(|_| {
                            ApiError::conflict(
                                "Transcript Claude cambiato. Apri una nuova anteprima.",
                            )
                        })?;
                    if current != review.plan {
                        return Err(ApiError::conflict(
                            "Le risorse Claude sono cambiate. Apri una nuova anteprima.",
                        ));
                    }
                    let outcome = current.delete();
                    result(
                        outcome.removed_files,
                        format!(
                            "{} file eliminati · {} byte logici · {} righe di history eliminate.",
                            outcome.removed_files, outcome.removed_bytes, outcome.history_rows,
                        ),
                        outcome.errors,
                    )
                }
                #[cfg(not(any(target_os = "macos", windows)))]
                return Err(ApiError::conflict(
                    agentmender_provider_claude::REMOVAL_NOTICE,
                ));
            }
        };
        app.inventory.invalidate(provider);
        Ok(outcome)
    })
    .await
}

pub(super) async fn project(
    State(app): State<Arc<App>>,
    Path(key): Path<String>,
    Json(request): Json<Confirmation>,
) -> Result<Json<ResultView>, ApiError> {
    if !request.confirm {
        return Err(ApiError::bad("Conferma l’eliminazione definitiva."));
    }
    read(app, move |app| {
        let _mutation = app.mutations.lock().map_err(|_| ApiError::internal())?;
        let outcome = confirm_codex(app, key, true, request.review)?;
        app.inventory.invalidate(ProviderKind::Codex);
        Ok(outcome)
    })
    .await
}
