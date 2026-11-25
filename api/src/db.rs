//! The saved-edit store: one SQLite file beside `settings.json`.
//!
//! SQLite rather than anything with a server, because the only thing stored
//! here is cut lists - a few kilobytes each, written by one person, read back
//! by title. A service would mean a port, credentials, a memory footprint and
//! another thing to start in the LXC, in exchange for nothing this workload
//! asks for. `rusqlite`'s bundled feature compiles SQLite into the binary, so
//! the runtime image needs no package at all and a backup is one file copy.
//!
//! ⚠ **The file must live on local disk, never on the share.** SQLite takes
//! locks the way POSIX expects, and SMB/CIFS does not honour them reliably; a
//! database opened over a share can be corrupted by nothing more dramatic than
//! two writes landing together. `config/` is already a host bind mount, which
//! gives the same survive-a-rebuild property the old files had on the share.
//!
//! The cost of that, named rather than hidden: cut lists **no longer travel
//! with the library**. They used to sit beside the films, so moving the media
//! to another machine moved the cuts with it. Now they move with `config/`.
//!
//! The one-time import from those per-file cut lists lived here until
//! 2026-11-25; it had run, and the folder it read is no longer referenced by
//! anything. Restoring this database means copying the file back, not
//! re-reading the share.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use rusqlite::Connection;

use crate::ApiError;

/// Bumped when the schema changes; `migrate` applies everything above the
/// file's current `user_version`. Stored in the database itself rather than in
/// a table, which is what `user_version` is for.
const SCHEMA_VERSION: i64 = 1;

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
    /// Kept so a snapshot can be written beside the live file - the same
    /// directory, so the rename-free copy never crosses a filesystem.
    path: PathBuf,
}

/// Beside `settings.json`, for the same reason the log file is: that directory
/// is the one already bind-mounted to survive a rebuild.
pub fn db_path(config_path: &Path) -> PathBuf {
    std::env::var("VEDITOR_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            config_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("edits.db")
        })
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let have: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if have >= SCHEMA_VERSION {
        return Ok(());
    }
    if have < 1 {
        conn.execute_batch(
            // Keyed by TITLE, exactly as the files were. That is a deliberate
            // behaviour, not an artefact of how they were stored: the same film
            // turns up at more than one path, and cuts you can only load from
            // the path they were saved at are cuts you cannot find when you
            // need them. A primary key on it also makes a save a plain upsert,
            // which is what removes the old scheme's "twin file" problem
            // outright rather than cleaning up after it.
            //
            // Segments are one JSON array rather than a child table. They are
            // always read and written whole, nothing queries inside them, and a
            // row per segment would buy ordering bugs and nothing else.
            "CREATE TABLE IF NOT EXISTS edits (
                 title        TEXT    PRIMARY KEY,
                 source       TEXT    NOT NULL,
                 source_size  INTEGER NOT NULL DEFAULT 0,
                 source_mtime INTEGER NOT NULL DEFAULT 0,
                 duration     REAL    NOT NULL DEFAULT 0,
                 fps          REAL    NOT NULL DEFAULT 0,
                 segments     TEXT    NOT NULL,
                 saved_at     INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS edits_saved_at ON edits (saved_at DESC);
             -- Key/value side table. Nothing reads it any more: it held the
             -- marker recording the one-time import of per-file cut lists,
             -- removed 2026-11-25 once that import had run. Kept as the
             -- record it is, and because dropping it would mean a migration
             -- that buys nothing.
             CREATE TABLE IF NOT EXISTS meta (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )?;
    }
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Db> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        // WAL so a read never blocks behind the autosave's write, and NORMAL
        // because losing the last few milliseconds of an autosave to a power
        // cut is not worth an fsync on every keystroke. busy_timeout covers the
        // one case a single process can still contend with itself: a blocking
        // task mid-write while another starts.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&conn)?;
        Ok(Db {
            conn: Arc::new(Mutex::new(conn)),
            path: path.to_path_buf(),
        })
    }

    /// Runs one piece of database work off the async runtime.
    ///
    /// `rusqlite` is synchronous, and these queries are small enough that
    /// blocking inline would usually be harmless - but "usually" is how an
    /// executor ends up stalled behind a `.part` file on a sleeping NAS. The
    /// lock is taken inside the blocking closure, so it is never held across an
    /// await point.
    pub async fn call<T, F>(&self, f: F) -> Result<T, ApiError>
    where
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn
                .lock()
                .map_err(|_| ApiError::Internal("the saved-edit store is poisoned".into()))?;
            f(&guard).map_err(|e| ApiError::Internal(format!("saved-edit store: {e}")))
        })
        .await
        .map_err(|e| ApiError::Internal(format!("saved-edit store task failed: {e}")))?
    }

    /// A consistent copy of the whole database, as bytes.
    ///
    /// `VACUUM INTO` rather than reading `edits.db` off disk, because in WAL
    /// mode the live file is only half the story - the recent writes are in
    /// `edits.db-wal`, so a plain file copy can hand back a database missing
    /// the last cut list saved. `VACUUM INTO` writes one self-contained,
    /// already-compacted file from a single read transaction.
    ///
    /// The snapshot is written beside the database, read, and deleted. It is
    /// small - a few hundred KB for hundreds of cut lists - so holding it in
    /// memory to serve is cheaper than streaming a file that then has to be
    /// cleaned up if the client disconnects mid-download.
    pub async fn snapshot(&self) -> Result<Vec<u8>, ApiError> {
        let tmp = self.path.with_file_name(format!(
            "{}.snapshot-{}.db",
            self.path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "edits.db".into()),
            std::process::id()
        ));
        // VACUUM INTO refuses to write over an existing file, so a snapshot
        // left behind by a killed process would block every later download.
        let _ = tokio::fs::remove_file(&tmp).await;

        let target = tmp.to_string_lossy().to_string();
        self.call(move |c| c.execute("VACUUM INTO ?1", [&target]).map(|_| ()))
            .await?;

        let bytes = tokio::fs::read(&tmp)
            .await
            .map_err(|e| ApiError::Internal(format!("snapshot could not be read back: {e}")));
        let _ = tokio::fs::remove_file(&tmp).await;
        bytes
    }
}
