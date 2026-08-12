//! Saved edits.
//!
//! An edit is the cut list for one source file. They are stored **next to the
//! media, on the share** rather than in the container: the cuts belong with the
//! film, they survive a rebuild or a reinstall, and if the library moves to
//! another machine the edits go with it.
//!
//! One file per source, named after it, so the folder stays browsable by hand.

use std::path::{Path, PathBuf};

use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{to_real_path, ApiError, AppState};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EditSegment {
    pub start: f64,
    pub end: f64,
    pub keep: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedEdit {
    /// Absolute path of the clip this edit belongs to.
    pub source: String,
    /// Size and mtime at save time, so a replaced file can be flagged rather
    /// than silently loading cuts that no longer line up with the picture.
    #[serde(default)]
    pub source_size: u64,
    #[serde(default)]
    pub source_mtime: u64,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub fps: f64,
    pub segments: Vec<EditSegment>,
    #[serde(default)]
    pub saved_at: u64,
    /// Set by the server on load when size/mtime no longer match.
    #[serde(default)]
    pub stale: bool,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Keeps the saved name recognisable while staying unique: a basename plus a
/// short hash of the full path, so two clips with the same filename in
/// different folders do not collide.
fn edit_filename(source: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    source.to_string_lossy().hash(&mut h);
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip".into());
    // Keep it filesystem-safe; SMB shares dislike a good many characters.
    let safe: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .take(80)
        .collect();
    format!("{safe}.{:08x}.wve.json", (h.finish() & 0xffff_ffff) as u32)
}

/// Where edits live. Configured in Settings; empty means the feature is off.
async fn edits_dir(st: &AppState) -> Result<PathBuf, ApiError> {
    let s = st.settings.read().await;
    let d = s.edits_dir.trim().to_string();
    if d.is_empty() {
        return Err(ApiError::Bad(
            "No folder is configured for saved edits. Settings → Saved edits.".into(),
        ));
    }
    Ok(PathBuf::from(d))
}

#[derive(Deserialize)]
pub struct EditQuery {
    pub path: String,
}

pub async fn load_edit(
    State(st): State<AppState>,
    Query(q): Query<EditQuery>,
) -> Result<Json<Option<SavedEdit>>, ApiError> {
    let src = to_real_path(&st, "", &q.path).await?;
    let dir = match edits_dir(&st).await {
        Ok(d) => d,
        // Not configured is not an error for a load - there is simply nothing.
        Err(_) => return Ok(Json(None)),
    };
    let file = dir.join(edit_filename(&src));

    let Ok(text) = tokio::fs::read_to_string(&file).await else {
        return Ok(Json(None));
    };
    let Ok(mut edit) = serde_json::from_str::<SavedEdit>(&text) else {
        tracing::warn!("saved edit {} is unreadable", file.display());
        return Ok(Json(None));
    };

    if let Ok(md) = tokio::fs::metadata(&src).await {
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        edit.stale = edit.source_size != 0 && (edit.source_size != md.len() || edit.source_mtime != mtime);
    }
    Ok(Json(Some(edit)))
}

pub async fn save_edit(
    State(st): State<AppState>,
    Json(mut edit): Json<SavedEdit>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let src = to_real_path(&st, "", &edit.source).await?;
    let dir = edits_dir(&st).await?;

    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::Bad(format!("cannot create {}: {e}", dir.display())))?;

    if let Ok(md) = tokio::fs::metadata(&src).await {
        edit.source_size = md.len();
        edit.source_mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
    }
    edit.source = src.to_string_lossy().to_string();
    edit.saved_at = now();
    edit.stale = false;

    let file = dir.join(edit_filename(&src));
    let json = serde_json::to_string_pretty(&edit).map_err(|e| ApiError::Internal(e.to_string()))?;

    // Write-then-rename: an interrupted autosave must not leave a half-written
    // cut list where a valid one used to be.
    let tmp = file.with_extension("part");
    tokio::fs::write(&tmp, json)
        .await
        .map_err(|e| ApiError::Bad(format!("cannot write to {}: {e}", dir.display())))?;
    tokio::fs::rename(&tmp, &file)
        .await
        .map_err(|e| ApiError::Bad(format!("cannot save: {e}")))?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "file": file.to_string_lossy(),
        "segments": edit.segments.len(),
    })))
}

pub async fn delete_edit(
    State(st): State<AppState>,
    Query(q): Query<EditQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let src = to_real_path(&st, "", &q.path).await?;
    let dir = edits_dir(&st).await?;
    let file = dir.join(edit_filename(&src));
    let existed = tokio::fs::remove_file(&file).await.is_ok();
    Ok(Json(serde_json::json!({ "ok": true, "removed": existed })))
}

#[derive(Serialize)]
pub struct EditSummary {
    pub source: String,
    pub name: String,
    pub segments: usize,
    pub kept: usize,
    pub saved_at: u64,
    pub exists: bool,
}

/// Every saved edit, so the UI can offer them as presets to reopen.
pub async fn list_edits(State(st): State<AppState>) -> Result<Json<Vec<EditSummary>>, ApiError> {
    let dir = match edits_dir(&st).await {
        Ok(d) => d,
        Err(_) => return Ok(Json(vec![])),
    };
    let mut out = Vec::new();
    let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
        return Ok(Json(out));
    };
    while let Ok(Some(e)) = rd.next_entry().await {
        let p = e.path();
        if !p.to_string_lossy().ends_with(".wve.json") {
            continue;
        }
        let Ok(text) = tokio::fs::read_to_string(&p).await else { continue };
        let Ok(edit) = serde_json::from_str::<SavedEdit>(&text) else { continue };
        let src = PathBuf::from(&edit.source);
        out.push(EditSummary {
            name: src
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            segments: edit.segments.len(),
            kept: edit.segments.iter().filter(|s| s.keep).count(),
            saved_at: edit.saved_at,
            exists: src.is_file(),
            source: edit.source,
        });
    }
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(Json(out))
}
