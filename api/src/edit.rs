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
    http::header,
    response::{IntoResponse, Response},
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
    /// The database key. The UI selects, exports and deletes by this rather
    /// than by path: two rows can never share it, and a row whose film has been
    /// moved still has one.
    pub title: String,
    pub source: String,
    pub name: String,
    pub segments: usize,
    pub kept: usize,
    /// Seconds of the clip the kept segments add up to - what the export would
    /// actually produce, which is the number worth sorting a long list by.
    pub kept_seconds: f64,
    pub duration: f64,
    pub saved_at: u64,
    pub exists: bool,
}

/// Every saved edit, so the UI can offer them as presets to reopen.
pub async fn list_edits(State(st): State<AppState>) -> Result<Json<Vec<EditSummary>>, ApiError> {
    let rows = all_rows(&st).await?;

    // `exists` is a stat per row, against the share. Left as it was: this list
    // is opened deliberately, and knowing which cut lists point at a film that
    // is no longer there is most of the reason to open it.
    let mut out = Vec::with_capacity(rows.len());
    for (title, edit) in rows {
        let src = PathBuf::from(&edit.source);
        out.push(EditSummary {
            title,
            name: src
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            segments: edit.segments.len(),
            kept: edit.segments.iter().filter(|s| s.keep).count(),
            kept_seconds: edit
                .segments
                .iter()
                .filter(|s| s.keep)
                .map(|s| (s.end - s.start).max(0.0))
                .sum(),
            duration: edit.duration,
            saved_at: edit.saved_at,
            exists: src.is_file(),
            source: edit.source,
        });
    }
    Ok(Json(out))
}

// ------------------------------------------------- export, import, bulk delete

/// Every row with its key, newest first.
async fn all_rows(st: &AppState) -> Result<Vec<(String, SavedEdit)>, ApiError> {
    st.db
        .call(|c| {
            let sql = format!("SELECT {SELECT_COLS} FROM edits ORDER BY saved_at DESC");
            let mut stmt = c.prepare(&sql)?;
            let it = stmt.query_map([], |r| Ok((r.get::<_, String>("title")?, row_to_edit(r)?)))?;
            it.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await
}

/// The file format for export and import.
///
/// Wrapped in an object rather than being a bare array so it can carry a
/// version: a file saved today has to still be readable by a build that has
/// learned a new field, and the only way to know what is missing is to know
/// which shape it was written in.
#[derive(Serialize, Deserialize)]
pub struct Bundle {
    pub version: u32,
    pub exported_at: u64,
    pub edits: Vec<BundleEdit>,
}

/// One cut list in a bundle. `title` is written out so a round trip cannot
/// re-key a row by accident, but on import the source path decides, exactly as
/// it does for a save - see `import_edits`.
#[derive(Serialize, Deserialize)]
pub struct BundleEdit {
    #[serde(default)]
    pub title: String,
    #[serde(flatten)]
    pub edit: SavedEdit,
}

const BUNDLE_VERSION: u32 = 1;

#[derive(Deserialize)]
pub struct ExportReq {
    /// Which rows to include. Empty means all of them, so "export everything"
    /// needs no special case in the client.
    #[serde(default)]
    pub titles: Vec<String>,
}

pub async fn export_edits(
    State(st): State<AppState>,
    Json(req): Json<ExportReq>,
) -> Result<Json<Bundle>, ApiError> {
    let wanted: Option<std::collections::HashSet<String>> = if req.titles.is_empty() {
        None
    } else {
        Some(req.titles.into_iter().collect())
    };

    let edits = all_rows(&st)
        .await?
        .into_iter()
        .filter(|(t, _)| wanted.as_ref().map(|w| w.contains(t)).unwrap_or(true))
        .map(|(title, edit)| BundleEdit { title, edit })
        .collect::<Vec<_>>();

    tracing::info!("exported {} cut list(s)", edits.len());
    Ok(Json(Bundle {
        version: BUNDLE_VERSION,
        exported_at: now(),
        edits,
    }))
}

#[derive(Deserialize)]
pub struct ImportQuery {
    /// Validate and count, write nothing. The UI runs this first and shows the
    /// outcome, so "import" is never a button whose effect you discover
    /// afterwards.
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Serialize)]
pub struct Rejected {
    pub name: String,
    pub reason: String,
}

/// Why a cut list is rejected rather than stored.
///
/// ⚠ The editor's one invariant is that segments **tile the clip end to end**,
/// with no gaps and no overlaps - deleting is a flag, never a removal. A file
/// that breaks it would load as an edit the UI cannot represent or redraw, so
/// it is refused at the door with the reason said out loud. Everything else
/// about an imported row is taken as given, including a source path whose film
/// no longer exists: cut lists outlive the files they describe, and refusing
/// those would make a backup unrestorable.
fn validate(edit: &SavedEdit) -> Result<(), String> {
    if edit.source.trim().is_empty() {
        return Err("no source path".into());
    }
    if edit.segments.is_empty() {
        return Err("no segments".into());
    }
    let mut prev_end: Option<f64> = None;
    for (i, s) in edit.segments.iter().enumerate() {
        if !s.start.is_finite() || !s.end.is_finite() {
            return Err(format!("segment {} has a non-finite time", i + 1));
        }
        if s.start < 0.0 {
            return Err(format!("segment {} starts before zero", i + 1));
        }
        if s.end <= s.start {
            return Err(format!("segment {} ends at or before its start", i + 1));
        }
        if let Some(p) = prev_end {
            // A twentieth of a frame at 24fps. Tight enough to catch a real
            // gap, loose enough to survive a JSON round trip of f64 seconds.
            if (s.start - p).abs() > 0.002 {
                return Err(format!(
                    "segment {} starts at {:.3}s but the one before it ends at {:.3}s - \
                     segments must tile the clip with no gaps or overlaps",
                    i + 1,
                    s.start,
                    p
                ));
            }
        } else if s.start > 0.002 {
            return Err(format!("first segment starts at {:.3}s, not at zero", s.start));
        }
        prev_end = Some(s.end);
    }
    Ok(())
}

/// Reads cut lists back in from a bundle, a bare array of them, or a single
/// one - which is the shape the old per-file `.wve.json` cut lists had, so a
/// folder of those can be dropped straight in.
///
/// Keyed by `title_key` of the source path in the file, **not** by the `title`
/// a bundle carries and **not** through `to_real_path`: an import has to work
/// for a film that has since been deleted or moved, which is most of what a
/// restore is for. The consequence is that importing is the one way to create
/// a row for a path this server cannot see, and that is deliberate.
pub async fn import_edits(
    State(st): State<AppState>,
    Query(q): Query<ImportQuery>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let items: Vec<serde_json::Value> = match body {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(ref o) if o.contains_key("edits") => {
            match o.get("edits") {
                Some(serde_json::Value::Array(a)) => a.clone(),
                _ => return Err(ApiError::Bad("\"edits\" is not a list".into())),
            }
        }
        other @ serde_json::Value::Object(_) => vec![other],
        _ => {
            return Err(ApiError::Bad(
                "expected a bundle, a list of cut lists, or one cut list".into(),
            ))
        }
    };

    let mut added = 0usize;
    let mut updated = 0usize;
    let mut rejected: Vec<Rejected> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for (i, item) in items.iter().enumerate() {
        // Named by its film, because that is what you recognise in a list of
        // rejections. Falls back to the position in the file, since a cut list
        // with no source is one of the things that gets rejected.
        let label = item
            .get("source")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| {
                Path::new(s)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| s.to_string())
            })
            .unwrap_or_else(|| format!("item {}", i + 1));

        let mut edit: SavedEdit = match serde_json::from_value(item.clone()) {
            Ok(e) => e,
            Err(e) => {
                rejected.push(Rejected { name: label, reason: format!("not a cut list: {e}") });
                continue;
            }
        };
        if let Err(reason) = validate(&edit) {
            rejected.push(Rejected { name: label, reason });
            continue;
        }

        let title = title_key(Path::new(&edit.source));
        // A file that names the same title twice would otherwise be counted as
        // two writes and reported as one row.
        let repeat = !seen.insert(title.clone());
        if edit.saved_at == 0 {
            edit.saved_at = now();
        }
        edit.stale = false;
        edit.matched_by = String::new();
        edit.saved_for = String::new();

        let t = title.clone();
        let existed = st.db.call(move |c| get_by_title(c, &t)).await?.is_some();

        if !q.dry_run {
            let row = edit.clone();
            let t = title.clone();
            if let Err(e) = st.db.call(move |c| upsert(c, &t, &row)).await {
                rejected.push(Rejected {
                    name: label,
                    reason: format!("could not be stored: {e:?}"),
                });
                continue;
            }
        }
        if existed || repeat {
            updated += 1;
        } else {
            added += 1;
        }
    }

    if q.dry_run {
        tracing::info!(
            "import check: {added} new, {updated} updating, {} rejected",
            rejected.len()
        );
    } else {
        tracing::info!(
            "imported {added} new and {updated} updated cut list(s), {} rejected",
            rejected.len()
        );
    }

    Ok(Json(serde_json::json!({
        "ok": true,
        "dry_run": q.dry_run,
        "added": added,
        "updated": updated,
        "rejected": rejected,
    })))
}

#[derive(Deserialize)]
pub struct DeleteReq {
    #[serde(default)]
    pub titles: Vec<String>,
    /// Delete every row whose source file is not there any more. Counted and
    /// reported, never combined with a silent pass over the rest.
    #[serde(default)]
    pub missing: bool,
    /// How many rows the client was told it would delete.
    ///
    /// ⚠ The guard that matters here. `missing` is decided by a fresh stat per
    /// row, so a share that went offline between drawing the list and pressing
    /// the button makes every film look gone - and the number typed back would
    /// have been the small one. Finding more than promised is refused outright
    /// rather than reconciled.
    #[serde(default)]
    pub expect: Option<usize>,
}

/// Deletes rows by key, or every row whose film is gone.
pub async fn delete_edits(
    State(st): State<AppState>,
    Json(req): Json<DeleteReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut titles = req.titles;

    if req.missing {
        // Stat per row, on purpose: "missing" has to mean missing now, not
        // missing when the list was last drawn. A share that is offline makes
        // every film look gone, so this is also why the UI states the count it
        // is about to delete and requires it typed back.
        let mut found = 0usize;
        for (title, edit) in all_rows(&st).await? {
            if !PathBuf::from(&edit.source).is_file() {
                found += 1;
                titles.push(title);
            }
        }
        if let Some(expected) = req.expect {
            if found > expected {
                tracing::warn!(
                    "refused to delete {found} missing-film cut lists; {expected} were offered"
                );
                return Err(ApiError::Bad(format!(
                    "{found} cut lists now look like their film is missing, but you were \
                     shown {expected}. Nothing was deleted - check the share is still \
                     mounted, then try again."
                )));
            }
        }
    }
    if titles.is_empty() {
        return Ok(Json(serde_json::json!({ "ok": true, "removed": 0 })));
    }

    titles.sort();
    titles.dedup();
    let n = titles.len();
    let removed = st
        .db
        .call(move |c| {
            let tx = c.unchecked_transaction()?;
            let mut done = 0usize;
            {
                let mut stmt = tx.prepare("DELETE FROM edits WHERE title = ?1")?;
                for t in &titles {
                    done += stmt.execute([t])?;
                }
            }
            tx.commit()?;
            Ok(done)
        })
        .await?;

    tracing::info!("deleted {removed} cut list(s) of {n} asked for");
    Ok(Json(serde_json::json!({ "ok": true, "removed": removed })))
}

/// The database itself, as a download.
///
/// The honest backup: one file, and restoring it is copying it back into
/// `config/`. A JSON export is for reading the cuts elsewhere; this is for
/// getting them back.
pub async fn download_db(State(st): State<AppState>) -> Result<Response, ApiError> {
    let bytes = st.db.snapshot().await?;
    let name = format!(
        "edits-{}.db",
        chrono_ish_date(now())
    );
    tracing::info!("database download: {} bytes", bytes.len());

    Ok((
        [
            (header::CONTENT_TYPE, "application/vnd.sqlite3".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
        ],
        bytes,
    )
        .into_response())
}

/// `YYYY-MM-DD` from a unix timestamp, without taking a date library for one
/// filename. Civil-from-days, as in Howard Hinnant's algorithm.
fn chrono_ish_date(ts: u64) -> String {
    let days = (ts / 86_400) as i64 + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = (days - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}
