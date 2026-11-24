//! Saved edits.
//!
//! An edit is the cut list for one source file. They live in a SQLite database
//! beside `settings.json` - see `db.rs` for why that, and why it may not sit on
//! the share.
//!
//! Keyed by TITLE rather than by full path, which is the one behaviour here
//! worth defending. The same film turns up at more than one path - a copy on
//! another share, a reorganised folder, a second download - and cuts that only
//! load from the exact path they were saved at are cuts you cannot find when
//! you need them. Matching on the title means the work follows the film.
//!
//! The cost is real and accepted: two genuinely different files sharing a
//! filename share a cut list. Loads that resolve by title rather than by exact
//! path are reported back as such, so the UI can say where the cuts came from
//! instead of quietly applying someone else's.

use std::path::{Path, PathBuf};

use axum::{
    extract::{Query, State},
    Json,
};
use rusqlite::Connection;
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
    /// How this edit was found: "path" when it was saved against this exact
    /// file, "title" when it came from the same filename somewhere else. The UI
    /// says so, because applying another copy's cuts silently is the one way
    /// title matching can bite.
    #[serde(default)]
    pub matched_by: String,
    /// The path the cuts were saved against, when that is not this file.
    #[serde(default)]
    pub saved_for: String,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The title, made filesystem-safe.
///
/// It is a database key now rather than a filename, so the character filtering
/// is no longer strictly required - but it is kept exactly as it was, because
/// changing it would silently orphan every row imported under the old spelling.
fn title_key(source: &Path) -> String {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip".into());
    stem.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .take(80)
        .collect()
}

// ---------------------------------------------------------------- rows

const SELECT_COLS: &str =
    "title, source, source_size, source_mtime, duration, fps, segments, saved_at";

/// One row, as the API returns it.
///
/// `stale`, `matched_by` and `saved_for` are decided per request rather than
/// stored - they describe this lookup, not the edit.
fn row_to_edit(r: &rusqlite::Row<'_>) -> rusqlite::Result<SavedEdit> {
    let segments: String = r.get("segments")?;
    Ok(SavedEdit {
        source: r.get("source")?,
        source_size: r.get::<_, i64>("source_size")? as u64,
        source_mtime: r.get::<_, i64>("source_mtime")? as u64,
        duration: r.get("duration")?,
        fps: r.get("fps")?,
        // A row whose JSON will not parse reads as no cuts rather than as an
        // error: one unreadable edit must not take out the whole list.
        segments: serde_json::from_str(&segments).unwrap_or_default(),
        saved_at: r.get::<_, i64>("saved_at")? as u64,
        stale: false,
        matched_by: String::new(),
        saved_for: String::new(),
    })
}

fn get_by_title(c: &Connection, title: &str) -> rusqlite::Result<Option<SavedEdit>> {
    let sql = format!("SELECT {SELECT_COLS} FROM edits WHERE title = ?1");
    c.query_row(&sql, [title], row_to_edit)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

fn upsert(c: &Connection, title: &str, e: &SavedEdit) -> rusqlite::Result<()> {
    let segments = serde_json::to_string(&e.segments).unwrap_or_else(|_| "[]".into());
    c.execute(
        "INSERT INTO edits (title, source, source_size, source_mtime, duration, fps, segments, saved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(title) DO UPDATE SET
             source       = excluded.source,
             source_size  = excluded.source_size,
             source_mtime = excluded.source_mtime,
             duration     = excluded.duration,
             fps          = excluded.fps,
             segments     = excluded.segments,
             saved_at     = excluded.saved_at",
        rusqlite::params![
            title,
            e.source,
            e.source_size as i64,
            e.source_mtime as i64,
            e.duration,
            e.fps,
            segments,
            e.saved_at as i64,
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------- handlers

#[derive(Deserialize)]
pub struct EditQuery {
    pub path: String,
}

pub async fn load_edit(
    State(st): State<AppState>,
    Query(q): Query<EditQuery>,
) -> Result<Json<Option<SavedEdit>>, ApiError> {
    let src = to_real_path(&st, "", &q.path).await?;
    let title = title_key(&src);

    let Some(mut edit) = st.db.call(move |c| get_by_title(c, &title)).await? else {
        return Ok(Json(None));
    };

    // Saved against this very file, or against another copy of it?
    let same_path = edit.source == src.to_string_lossy();
    edit.matched_by = if same_path { "path".into() } else { "title".into() };
    edit.saved_for = if same_path { String::new() } else { edit.source.clone() };

    if let Ok(md) = tokio::fs::metadata(&src).await {
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Size and mtime only mean anything about the file they were recorded
        // from. For another copy they are guaranteed to differ, so testing them
        // would flag every title match as stale and teach you to ignore the
        // warning. Duration is what decides whether the cuts still line up, and
        // the client checks that against the clip it actually opened.
        edit.stale = same_path
            && edit.source_size != 0
            && (edit.source_size != md.len() || edit.source_mtime != mtime);
    }

    if !same_path {
        tracing::info!(
            "cuts for {} loaded by title, saved against {}",
            src.display(), edit.source
        );
    }
    Ok(Json(Some(edit)))
}

pub async fn save_edit(
    State(st): State<AppState>,
    Json(mut edit): Json<SavedEdit>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let src = to_real_path(&st, "", &edit.source).await?;

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
    edit.matched_by = String::new();
    edit.saved_for = String::new();

    let title = title_key(&src);
    let count = edit.segments.len();

    // One upsert on the title key, which is what replaced the old
    // write-then-rename plus delete-the-legacy-twin dance. There is no window
    // in which a half-written cut list exists, and no second file to migrate.
    let row = edit.clone();
    let t = title.clone();
    st.db.call(move |c| upsert(c, &t, &row)).await?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "title": title,
        "segments": count,
    })))
}

pub async fn delete_edit(
    State(st): State<AppState>,
    Query(q): Query<EditQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let src = to_real_path(&st, "", &q.path).await?;
    let title = title_key(&src);
    let removed = st
        .db
        .call(move |c| c.execute("DELETE FROM edits WHERE title = ?1", [&title]))
        .await?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "removed": removed > 0,
        "files": removed,
    })))
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
    let rows: Vec<SavedEdit> = st
        .db
        .call(|c| {
            let sql = format!("SELECT {SELECT_COLS} FROM edits ORDER BY saved_at DESC");
            let mut stmt = c.prepare(&sql)?;
            let it = stmt.query_map([], row_to_edit)?;
            it.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;

    // `exists` is a stat per row, against the share. Left as it was: this list
    // is opened deliberately, and knowing which cut lists point at a film that
    // is no longer there is most of the reason to open it.
    let mut out = Vec::with_capacity(rows.len());
    for edit in rows {
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
    Ok(Json(out))
}

// ---------------------------------------------------------------- import

/// Pulls every `*.wve.json` in the configured folder into the database, once.
///
/// Runs at startup, after the shares have been given their one mount attempt -
/// the files are on the share, so importing before that reads an empty
/// directory and would mark the job done having moved nothing.
///
/// ⚠ **Nothing on the share is modified or removed.** The files stop being read
/// after this and become dead weight, which is deliberate: they are the
/// fallback if this import got something wrong, and quietly deleting someone's
/// cut lists to tidy up is not a trade worth making on their behalf.
pub async fn import_from_files(st: &AppState) {
    const MARKER: &str = "imported_from_files";

    if st.db.meta_get(MARKER).await.is_some() {
        return;
    }

    let dir = {
        let s = st.settings.read().await;
        s.edits_dir.trim().to_string()
    };
    if dir.is_empty() {
        // Nothing configured is not an error, and it is not "done" either: a
        // folder set later still deserves importing on the next start.
        return;
    }
    let dir = PathBuf::from(dir);

    let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
        tracing::info!(
            "saved-edit import: {} is not readable yet - will try again next start",
            dir.display()
        );
        return;
    };

    // Oldest applied first, so where several files share a title the newest
    // wins the upsert. The old scheme could leave one file per path a clip had
    // ever been saved at, and the most recently written is the one that would
    // have been loaded.
    let mut found: Vec<(u64, PathBuf)> = Vec::new();
    while let Ok(Some(e)) = rd.next_entry().await {
        let p = e.path();
        if !p.to_string_lossy().ends_with(".wve.json") {
            continue;
        }
        let mtime = e
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        found.push((mtime, p));
    }
    found.sort_by_key(|(m, _)| *m);

    let mut imported = 0usize;
    let mut skipped = 0usize;
    for (_, file) in &found {
        let Ok(text) = tokio::fs::read_to_string(file).await else {
            skipped += 1;
            continue;
        };
        let Ok(edit) = serde_json::from_str::<SavedEdit>(&text) else {
            tracing::warn!("saved-edit import: {} is unreadable, left alone", file.display());
            skipped += 1;
            continue;
        };
        let title = title_key(Path::new(&edit.source));
        let row = edit.clone();
        match st.db.call(move |c| upsert(c, &title, &row)).await {
            Ok(()) => imported += 1,
            Err(e) => {
                tracing::warn!("saved-edit import: {} could not be stored: {e:?}", file.display());
                skipped += 1;
            }
        }
    }

    if found.is_empty() {
        tracing::info!("saved-edit import: no cut lists in {}", dir.display());
    } else {
        tracing::info!(
            "saved-edit import: {imported} cut list(s) from {} into the database, \
             {skipped} skipped - the original files were left untouched",
            dir.display()
        );
    }

    let _ = st.db.meta_set(MARKER, &now().to_string()).await;
}
