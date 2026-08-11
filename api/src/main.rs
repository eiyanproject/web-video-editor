//! Video Editor WebUI - Phase 0
//!
//! Library browsing, byte-range playback, runtime-editable roots, and SMB share
//! management.
//!
//! Roots are user-managed at runtime and stored in settings.json - not baked
//! into compose. `allow_any_path` (default on) lets you paste any absolute path
//! the container can see. This is a single-user tool on your own hardware; the
//! path handling that remains exists to stop malformed input breaking things,
//! not to police where you go.

mod media;

use std::{
    collections::VecDeque,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use axum::{
    body::Body,
    extract::{Query, State},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower::util::ServiceExt;
use tower_http::{cors::CorsLayer, services::ServeFile, trace::TraceLayer};

// ---------------------------------------------------------------- settings

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RootCfg {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub writable: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SmbCfg {
    pub name: String,
    /// `//host/share`, `\\host\share`, or `smb://host/share` - all normalised.
    pub address: String,
    #[serde(default)]
    pub username: String,
    /// Never returned by the API. Stored in settings.json, which is written 0600.
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub domain: String,
    /// Where it lands inside the container. Defaults to /mnt/smb/<name>.
    #[serde(default)]
    pub mountpoint: String,
    #[serde(default = "yes")]
    pub read_only: bool,
    #[serde(default)]
    pub auto_mount: bool,
    /// Extra -o options appended verbatim, for the awkward NAS out there.
    #[serde(default)]
    pub options: String,
    /// Request-only: wipe the stored password. Blank normally means "keep", so
    /// without this there is no way to remove one.
    #[serde(default, skip_serializing)]
    pub clear_password: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub roots: Vec<RootCfg>,
    #[serde(default)]
    pub smb: Vec<SmbCfg>,
    /// Allow browsing any absolute path the container can see, not just roots.
    #[serde(default = "yes")]
    pub allow_any_path: bool,
    /// Default export destination.
    #[serde(default)]
    pub output_dir: String,
    /// Credentials used by any share that leaves its own blank. Most people use
    /// one account for every share on the same NAS, so typing it once is enough.
    #[serde(default)]
    pub default_username: String,
    #[serde(default)]
    pub default_password: String,
    #[serde(default)]
    pub default_domain: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            roots: vec![],
            smb: vec![],
            allow_any_path: true,
            output_dir: String::new(),
            default_username: String::new(),
            default_password: String::new(),
            default_domain: String::new(),
        }
    }
}

impl Settings {
    /// Fills in any blank credential field from the global defaults.
    fn with_defaults(&self, c: &SmbCfg) -> SmbCfg {
        let mut r = c.clone();
        if r.username.trim().is_empty() {
            r.username = self.default_username.clone();
        }
        if r.password.is_empty() {
            r.password = self.default_password.clone();
        }
        if r.domain.trim().is_empty() {
            r.domain = self.default_domain.clone();
        }
        r
    }
}

impl SmbCfg {
    fn effective_mountpoint(&self) -> String {
        if self.mountpoint.trim().is_empty() {
            format!("/mnt/smb/{}", self.name)
        } else {
            self.mountpoint.trim().to_string()
        }
    }
    /// Accepts `\\host\share`, `smb://host/share` and `//host/share`.
    fn normalised_address(&self) -> String {
        let a = self.address.trim().replace('\\', "/");
        let a = a.strip_prefix("smb:").unwrap_or(&a).to_string();
        if a.starts_with("//") {
            a
        } else {
            format!("//{}", a.trim_start_matches('/'))
        }
    }
}

// ---------------------------------------------------------------- log capture

#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    /// Unix epoch seconds; the UI formats it.
    pub ts: u64,
    pub level: String,
    pub target: String,
    pub message: String,
}

/// Ring buffer of recent events, so the UI can show what happened without
/// anyone needing shell access to `docker logs`. Capped, because a long-running
/// container should not grow memory just by being talkative.
#[derive(Clone, Default)]
pub struct LogBuffer(Arc<Mutex<VecDeque<LogEntry>>>);

const LOG_CAPACITY: usize = 2000;

impl LogBuffer {
    fn push(&self, e: LogEntry) {
        if let Ok(mut b) = self.0.lock() {
            if b.len() >= LOG_CAPACITY {
                b.pop_front();
            }
            b.push_back(e);
        }
    }
    fn snapshot(&self) -> Vec<LogEntry> {
        self.0.lock().map(|b| b.iter().cloned().collect()).unwrap_or_default()
    }
    fn clear(&self) {
        if let Ok(mut b) = self.0.lock() {
            b.clear();
        }
    }
}

/// Pulls the formatted message plus any structured fields off an event.
struct MsgVisitor(String);

impl tracing::field::Visit for MsgVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let s = format!("{value:?}");
            if self.0.is_empty() {
                self.0 = s;
            } else {
                self.0 = format!("{s} {}", self.0);
            }
        } else {
            if !self.0.is_empty() {
                self.0.push(' ');
            }
            self.0.push_str(&format!("{}={:?}", field.name(), value));
        }
    }
}

struct CaptureLayer(LogBuffer);

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CaptureLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        let mut v = MsgVisitor(String::new());
        event.record(&mut v);
        let md = event.metadata();
        self.0.push(LogEntry {
            ts: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            level: md.level().to_string(),
            target: md.target().to_string(),
            message: v.0,
        });
    }
}

/// Last known outcome for a share. Recorded once at startup and again on every
/// explicit attempt - never on a timer. Polling a sleeping NAS just burns
/// processes and wakes disks for nothing.
#[derive(Clone, Debug, Serialize, Default)]
pub struct ShareState {
    pub online: bool,
    pub error: String,
    pub checked_at: u64,
    pub ever_checked: bool,
}

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<RwLock<Settings>>,
    pub config_path: PathBuf,
    pub logs: LogBuffer,
    pub status: Arc<RwLock<std::collections::HashMap<String, ShareState>>>,
    /// Files with a sprite build in flight, so a second request does not start
    /// a duplicate ffmpeg over the same (often network-backed) file.
    pub sprite_jobs: Arc<RwLock<std::collections::HashSet<PathBuf>>>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn load_settings(path: &Path) -> Settings {
    match tokio::fs::read_to_string(path).await {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            tracing::error!("settings.json is invalid ({e}); starting from defaults");
            Settings::default()
        }),
        Err(_) => Settings::default(),
    }
}

async fn save_settings(path: &Path, s: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    tokio::fs::write(path, json).await.map_err(|e| e.to_string())?;
    // Credentials live in here, so keep it owner-only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
    }
    Ok(())
}

// ---------------------------------------------------------------- errors

pub enum ApiError {
    NotFound,
    Bad(String),
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (code, msg) = match self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::Bad(m) => (StatusCode::BAD_REQUEST, m),
            ApiError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (code, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

// ---------------------------------------------------------------- path handling

/// Turns whatever was pasted into a real path.
///
/// Normalisation only: strip quotes, unify separators, drop a Windows drive
/// prefix the container cannot mean anything by. With `allow_any_path` on, any
/// absolute path that exists is accepted. Otherwise it must sit inside a root.
pub async fn to_real_path(st: &AppState, root: &str, rel: &str) -> Result<PathBuf, ApiError> {
    let s = st.settings.read().await;

    let clean = rel.trim().trim_matches('"').replace('\\', "/");
    let clean = clean.trim();

    // Explicit root given: resolve under it.
    if !root.is_empty() {
        let r = s
            .roots
            .iter()
            .find(|r| r.name == root)
            .ok_or_else(|| ApiError::Bad(format!("unknown root {root:?}")))?;
        let joined = PathBuf::from(&r.path).join(clean.trim_start_matches('/'));
        return joined.canonicalize().map_err(|_| ApiError::NotFound);
    }

    // Absolute container path.
    if clean.starts_with('/') {
        if let Ok(c) = PathBuf::from(clean).canonicalize() {
            if s.allow_any_path || s.roots.iter().any(|r| c.starts_with(&r.path)) {
                return Ok(c);
            }
            return Err(ApiError::Bad("path is outside every configured root".into()));
        }
    }

    // Host-style path (C:\... or a UNC share): try progressively shorter tails
    // against each root, so "Copy as path" from Explorer just works.
    let segs: Vec<&str> = clean
        .split('/')
        .filter(|x| !x.is_empty() && !x.ends_with(':'))
        .collect();
    for start in 0..segs.len() {
        let tail = segs[start..].join("/");
        for r in s.roots.iter() {
            if let Ok(c) = PathBuf::from(&r.path).join(&tail).canonicalize() {
                return Ok(c);
            }
        }
    }

    // Bare relative path against each root.
    for r in s.roots.iter() {
        if let Ok(c) = PathBuf::from(&r.path).join(clean).canonicalize() {
            return Ok(c);
        }
    }

    Err(ApiError::NotFound)
}

// ---------------------------------------------------------------- browse

/// Housekeeping folders that every NAS and Windows volume carries around.
/// They are never interesting here and they clutter the top of a share, which
/// is exactly where a first-time user looks.
const SYSTEM_DIRS: &[&str] = &[
    "$recycle.bin",
    "system volume information",
    "#recycle",          // Synology
    "@eadir",            // Synology thumbnails
    "#snapshot",         // NetApp / QNAP
    ".@__thumb",         // QNAP
    "lost+found",
    "$winreagent",
    "recycler",
];

fn is_system_dir(name: &str) -> bool {
    let n = name.to_lowercase();
    SYSTEM_DIRS.contains(&n.as_str()) || n.starts_with(".trash")
}

const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "m4v", "ts", "m2ts", "mts", "wmv", "flv", "webm", "mpg", "mpeg",
    "vob", "ogv", "3gp", "rmvb", "divx",
];

#[derive(Deserialize)]
struct BrowseQuery {
    #[serde(default)]
    root: String,
    #[serde(default)]
    path: String,
    /// Include non-video files. Off by default so the listing stays about
    /// video, but you cannot diagnose "where did my file go" through a filter
    /// that silently hides things.
    #[serde(default)]
    all: bool,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    /// Absolute container path. Unambiguous, and works with any root or none.
    abs: String,
    is_dir: bool,
    size: u64,
    mtime: u64,
    is_video: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    problem: Option<String>,
}

#[derive(Serialize)]
struct BrowseResponse {
    /// Where we actually ended up, so the UI can show it.
    path: String,
    parent: Option<String>,
    entries: Vec<Entry>,
    /// Counted server-side so the UI does not have to guess what was filtered.
    #[serde(default)]
    hidden_non_video: usize,
}

async fn browse(
    State(st): State<AppState>,
    Query(q): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, ApiError> {
    // Empty path with no root: show the roots themselves.
    let dir = if q.root.is_empty() && q.path.trim().is_empty() {
        let s = st.settings.read().await;
        let entries: Vec<Entry> = s
            .roots
            .iter()
            .map(|r| Entry {
                name: r.name.clone(),
                abs: r.path.clone(),
                is_dir: true,
                size: 0,
                mtime: 0,
                is_video: false,
                problem: if PathBuf::from(&r.path).is_dir() {
                    None
                } else {
                    Some("not mounted or missing".into())
                },
            })
            .collect();
        return Ok(Json(BrowseResponse {
            path: String::new(),
            parent: None,
            entries,
            hidden_non_video: 0,
        }));
    } else {
        to_real_path(&st, &q.root, &q.path).await?
    };

    if !dir.is_dir() {
        return Err(ApiError::Bad("not a directory".into()));
    }

    let mut rd = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| ApiError::Internal(format!("cannot read directory: {e}")))?;

    let mut entries = Vec::new();
    let mut hidden_non_video = 0usize;
    while let Some(e) = rd
        .next_entry()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
    {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || is_system_dir(&name) {
            continue;
        }
        let md = match e.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = md.is_dir();
        let ext = Path::new(&name)
            .extension()
            .map(|x| x.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let is_video = !is_dir && VIDEO_EXTS.contains(&ext.as_str());
        if !is_dir && !is_video {
            hidden_non_video += 1;
            if !q.all {
                continue;
            }
        }

        let problem = if is_dir {
            None
        } else if md.len() == 0 {
            Some("file is empty (0 bytes)".to_string())
        } else if md.len() < 1024 {
            Some(format!("suspiciously small ({} bytes) - likely truncated", md.len()))
        } else {
            None
        };

        entries.push(Entry {
            name,
            abs: e.path().to_string_lossy().to_string(),
            is_dir,
            size: if is_dir { 0 } else { md.len() },
            mtime: md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            is_video,
            problem,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(Json(BrowseResponse {
        path: dir.to_string_lossy().to_string(),
        parent: dir.parent().map(|p| p.to_string_lossy().to_string()),
        entries,
        hidden_non_video,
    }))
}

// ---------------------------------------------------------------- resolve

#[derive(Deserialize)]
struct ResolveQuery {
    path: String,
}

#[derive(Serialize)]
struct ResolveResponse {
    abs: String,
    parent: Option<String>,
    name: String,
    is_dir: bool,
    is_video: bool,
}

async fn resolve_pasted(
    State(st): State<AppState>,
    Query(q): Query<ResolveQuery>,
) -> Result<Json<ResolveResponse>, ApiError> {
    let p = to_real_path(&st, "", &q.path).await?;
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = Path::new(&name)
        .extension()
        .map(|x| x.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let is_dir = p.is_dir();
    Ok(Json(ResolveResponse {
        abs: p.to_string_lossy().to_string(),
        parent: p.parent().map(|x| x.to_string_lossy().to_string()),
        name,
        is_dir,
        is_video: !is_dir && VIDEO_EXTS.contains(&ext.as_str()),
    }))
}

// ---------------------------------------------------------------- stream

#[derive(Deserialize)]
struct StreamQuery {
    #[serde(default)]
    root: String,
    path: String,
}

async fn stream(
    State(st): State<AppState>,
    Query(q): Query<StreamQuery>,
    req: Request<Body>,
) -> Result<Response, ApiError> {
    let file = to_real_path(&st, &q.root, &q.path).await?;
    if !file.is_file() {
        return Err(ApiError::NotFound);
    }
    let res = ServeFile::new(file)
        .oneshot(req)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(res.map(Body::new))
}

// ---------------------------------------------------------------- settings API

#[derive(Serialize)]
struct SmbPublic {
    name: String,
    address: String,
    username: String,
    domain: String,
    mountpoint: String,
    read_only: bool,
    auto_mount: bool,
    options: String,
    /// True when a password is stored. The value itself never leaves the server.
    has_password: bool,
    mounted: bool,
    /// Outcome of the last attempt. `ever_checked == false` means we have not
    /// tried yet, which is different from "tried and failed" and must read
    /// differently in the UI.
    online: bool,
    ever_checked: bool,
    last_error: String,
    checked_at: u64,
}

#[derive(Serialize)]
struct SettingsPublic {
    roots: Vec<RootCfg>,
    smb: Vec<SmbPublic>,
    allow_any_path: bool,
    output_dir: String,
    default_username: String,
    default_domain: String,
    /// Same contract as per-share passwords: presence only, never the value.
    has_default_password: bool,
}

async fn is_mounted(mp: &str) -> bool {
    match tokio::fs::read_to_string("/proc/mounts").await {
        Ok(m) => m.lines().any(|l| {
            let mut it = l.split_whitespace();
            it.next();
            it.next().map(|p| p == mp).unwrap_or(false)
        }),
        Err(_) => false,
    }
}

async fn get_settings(State(st): State<AppState>) -> Json<SettingsPublic> {
    let s = st.settings.read().await;
    let status = st.status.read().await;
    let mut smb = Vec::new();
    for c in s.smb.iter() {
        let mp = c.effective_mountpoint();
        let mounted = is_mounted(&mp).await;
        let sv = status.get(&c.name).cloned().unwrap_or_default();
        smb.push(SmbPublic {
            online: mounted || sv.online,
            ever_checked: sv.ever_checked,
            last_error: sv.error.clone(),
            checked_at: sv.checked_at,
            name: c.name.clone(),
            address: c.address.clone(),
            username: c.username.clone(),
            domain: c.domain.clone(),
            mountpoint: mp.clone(),
            read_only: c.read_only,
            auto_mount: c.auto_mount,
            options: c.options.clone(),
            has_password: !c.password.is_empty(),
            mounted,
        });
    }
    Json(SettingsPublic {
        roots: s.roots.clone(),
        smb,
        allow_any_path: s.allow_any_path,
        output_dir: s.output_dir.clone(),
        default_username: s.default_username.clone(),
        default_domain: s.default_domain.clone(),
        has_default_password: !s.default_password.is_empty(),
    })
}

#[derive(Deserialize)]
struct SettingsUpdate {
    #[serde(default)]
    roots: Option<Vec<RootCfg>>,
    #[serde(default)]
    smb: Option<Vec<SmbCfg>>,
    #[serde(default)]
    allow_any_path: Option<bool>,
    #[serde(default)]
    output_dir: Option<String>,
    #[serde(default)]
    default_username: Option<String>,
    #[serde(default)]
    default_password: Option<String>,
    #[serde(default)]
    default_domain: Option<String>,
    /// Explicitly forget the stored default password.
    #[serde(default)]
    clear_default_password: Option<bool>,
}

async fn put_settings(
    State(st): State<AppState>,
    Json(u): Json<SettingsUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    {
        let mut s = st.settings.write().await;
        if let Some(r) = u.roots {
            s.roots = r;
        }
        if let Some(new_smb) = u.smb {
            // An empty password means "keep the existing one" - the UI never
            // receives the stored value, so it cannot echo it back.
            let old = s.smb.clone();
            s.smb = new_smb
                .into_iter()
                .map(|mut c| {
                    if c.clear_password {
                        c.password.clear();
                    } else if c.password.is_empty() {
                        if let Some(prev) = old.iter().find(|p| p.name == c.name) {
                            c.password = prev.password.clone();
                        }
                    }
                    c.clear_password = false;
                    c
                })
                .collect();
        }
        if let Some(a) = u.allow_any_path {
            s.allow_any_path = a;
        }
        if let Some(o) = u.output_dir {
            s.output_dir = o;
        }
        if let Some(v) = u.default_username {
            s.default_username = v;
        }
        if let Some(v) = u.default_domain {
            s.default_domain = v;
        }
        // Blank means "keep what is stored", same contract as per-share passwords.
        if let Some(v) = u.default_password {
            if !v.is_empty() {
                s.default_password = v;
            }
        }
        if u.clear_default_password.unwrap_or(false) {
            s.default_password.clear();
        }
    }
    let s = st.settings.read().await.clone();
    save_settings(&st.config_path, &s)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------------------------------------------------------------- SMB mounting

#[derive(Deserialize)]
struct SmbAction {
    name: String,
}

/// Runs mount.cifs for one configured share.
///
/// The password goes into a 0600 credentials file rather than the command line,
/// because anything on the command line is visible in /proc to every process in
/// the container. The file is removed as soon as mount returns.
async fn smb_mount_inner(c: &SmbCfg) -> Result<String, String> {
    let mp = c.effective_mountpoint();
    if is_mounted(&mp).await {
        return Ok(format!("{mp} is already mounted"));
    }
    tokio::fs::create_dir_all(&mp)
        .await
        .map_err(|e| format!("cannot create {mp}: {e}"))?;

    let cred_path = format!("/tmp/.smbcred-{}", c.name.replace('/', "_"));
    let cred = format!(
        "username={}\npassword={}\ndomain={}\n",
        c.username, c.password, c.domain
    );
    tokio::fs::write(&cred_path, cred)
        .await
        .map_err(|e| format!("cannot write credentials: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&cred_path, std::fs::Permissions::from_mode(0o600)).await;
    }

    let mut opts = format!("credentials={cred_path},iocharset=utf8,uid=0,gid=0");
    if c.read_only {
        opts.push_str(",ro");
    }
    if !c.options.trim().is_empty() {
        opts.push(',');
        opts.push_str(c.options.trim());
    }

    let out = tokio::process::Command::new("mount")
        .args(["-t", "cifs", &c.normalised_address(), &mp, "-o", &opts])
        .output()
        .await;

    let _ = tokio::fs::remove_file(&cred_path).await;

    match out {
        Ok(o) if o.status.success() => Ok(format!("mounted {} at {mp}", c.normalised_address())),
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            Err(if err.contains("not permitted") || err.contains("must be superuser") {
                format!("{err}\n\nThe container needs CAP_SYS_ADMIN to mount CIFS. Add `cap_add: [SYS_ADMIN]` to the api service (already set in docker-compose.dev.yml) and note that an unprivileged Proxmox LXC cannot mount CIFS internally - mount on the host there and add it as a plain root instead.")
            } else if err.is_empty() {
                "mount failed with no message".into()
            } else {
                err
            })
        }
        Err(e) => Err(format!("could not run mount: {e}. Is cifs-utils installed?")),
    }
}

async fn smb_mount(
    State(st): State<AppState>,
    Json(a): Json<SmbAction>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let cfg = {
        let s = st.settings.read().await;
        s.smb.iter().find(|c| c.name == a.name).map(|c| s.with_defaults(c))
    }
    .ok_or_else(|| ApiError::Bad(format!("no share named {:?}", a.name)))?;

    // attempt_mount records the outcome and registers the mount point as a
    // library folder on success.
    let msg = attempt_mount(&st, &cfg).await.map_err(ApiError::Bad)?;
    Ok(Json(serde_json::json!({ "ok": true, "message": msg })))
}

/// Mounts every share flagged auto_mount that is not already up.
/// Returns a per-share result rather than failing on the first problem.
async fn smb_mount_all(State(st): State<AppState>) -> Json<serde_json::Value> {
    let shares = {
        let s = st.settings.read().await;
        s.smb
            .iter()
            .filter(|c| c.auto_mount)
            .map(|c| s.with_defaults(c))
            .collect::<Vec<_>>()
    };
    let mut results = Vec::new();
    for c in shares {
        match attempt_mount(&st, &c).await {
            Ok(m) => results.push(serde_json::json!({ "name": c.name, "ok": true, "message": m })),
            Err(e) => results.push(serde_json::json!({ "name": c.name, "ok": false, "message": e })),
        }
    }
    Json(serde_json::json!({ "results": results }))
}

/// Tries each auto-mount share exactly ONCE at startup, then stops.
///
/// No retry timer, deliberately. If the NAS is asleep or the network is not up,
/// retrying on a schedule just burns processes and spins disks back up for
/// nothing. The share is marked offline with the actual reason, and the UI
/// offers a Reconnect button for when you know it is back.
fn spawn_initial_mount(st: AppState) {
    tokio::spawn(async move {
        let shares = {
            let s = st.settings.read().await;
            s.smb
                .iter()
                .filter(|c| c.auto_mount)
                .map(|c| s.with_defaults(c))
                .collect::<Vec<_>>()
        };
        if shares.is_empty() {
            return;
        }
        tracing::info!("connecting {} share(s) marked auto-mount", shares.len());
        for c in shares {
            // Outcome is recorded in the status map; a failure here is not fatal.
            let _ = attempt_mount(&st, &c).await;
        }
    });
}

/// One mount attempt, recording the outcome and keeping the library in step.
async fn attempt_mount(st: &AppState, c: &SmbCfg) -> Result<String, String> {
    let res = smb_mount_inner(c).await;
    let state = match &res {
        Ok(m) => {
            tracing::info!("share {}: {m}", c.name);
            ShareState { online: true, error: String::new(), checked_at: now_secs(), ever_checked: true }
        }
        Err(e) => {
            tracing::warn!("share {} is offline: {e}", c.name);
            ShareState { online: false, error: e.clone(), checked_at: now_secs(), ever_checked: true }
        }
    };
    st.status.write().await.insert(c.name.clone(), state);

    if res.is_ok() {
        let mut s = st.settings.write().await;
        let mp = c.effective_mountpoint();
        if !s.roots.iter().any(|r| r.path == mp) {
            s.roots.push(RootCfg { name: c.name.clone(), path: mp, writable: !c.read_only });
        }
        let snapshot = s.clone();
        drop(s);
        let _ = save_settings(&st.config_path, &snapshot).await;
    }
    res
}

async fn smb_unmount(
    State(st): State<AppState>,
    Json(a): Json<SmbAction>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mp = {
        let s = st.settings.read().await;
        s.smb
            .iter()
            .find(|c| c.name == a.name)
            .map(|c| c.effective_mountpoint())
    }
    .ok_or_else(|| ApiError::Bad(format!("no share named {:?}", a.name)))?;

    let out = tokio::process::Command::new("umount")
        .arg(&mp)
        .output()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    if out.status.success() {
        Ok(Json(serde_json::json!({ "ok": true, "message": format!("unmounted {mp}") })))
    } else {
        Err(ApiError::Bad(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ))
    }
}

/// Mounts to a scratch point and immediately unmounts, so credentials can be
/// checked without committing to anything.
async fn smb_test(
    State(st): State<AppState>,
    Json(c): Json<SmbCfg>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // A blank password in the posted draft means "use what is stored" - either
    // this share's saved password or the global default. Without this, pressing
    // Test on an already-saved share would fail for want of a password the UI
    // deliberately never received.
    let mut probe = {
        let s = st.settings.read().await;
        let mut merged = c.clone();
        if merged.password.is_empty() {
            if let Some(prev) = s.smb.iter().find(|p| p.name == c.name) {
                merged.password = prev.password.clone();
            }
        }
        s.with_defaults(&merged)
    };
    probe.mountpoint = format!("/tmp/.smbtest-{}", c.name.replace('/', "_"));
    probe.read_only = true;
    match smb_mount_inner(&probe).await {
        Ok(_) => {
            let listing = tokio::fs::read_dir(&probe.mountpoint).await.is_ok();
            let _ = tokio::process::Command::new("umount")
                .arg(&probe.mountpoint)
                .output()
                .await;
            let _ = tokio::fs::remove_dir(&probe.mountpoint).await;
            Ok(Json(serde_json::json!({
                "ok": true,
                "message": if listing { "Connected and listed the share." } else { "Mounted, but the directory could not be listed." }
            })))
        }
        Err(e) => Err(ApiError::Bad(e)),
    }
}

#[derive(Deserialize)]
struct CheckPath {
    path: String,
}

#[derive(Serialize)]
struct PathCheck {
    exists: bool,
    is_dir: bool,
    writable: bool,
    /// Whether it sits under something currently mounted, so the UI can warn
    /// about writing into a path that will vanish when a share drops.
    on_mount: bool,
    message: String,
}

/// Verifies an export destination before anything is written to it. Existence
/// is not enough - a read-only share looks like a perfectly good folder right
/// up until the export fails at the last step.
async fn check_path(
    State(_st): State<AppState>,
    Json(q): Json<CheckPath>,
) -> Json<PathCheck> {
    let p = PathBuf::from(q.path.trim().trim_matches('"').replace('\\', "/"));
    let exists = p.exists();
    let is_dir = p.is_dir();

    let mut writable = false;
    if is_dir {
        let probe = p.join(".veditor-write-test");
        if tokio::fs::write(&probe, b"x").await.is_ok() {
            writable = true;
            let _ = tokio::fs::remove_file(&probe).await;
        }
    }

    let mounts = tokio::fs::read_to_string("/proc/mounts").await.unwrap_or_default();
    let on_mount = mounts.lines().any(|l| {
        let mut it = l.split_whitespace();
        it.next();
        it.next()
            .map(|m| m != "/" && p.starts_with(m))
            .unwrap_or(false)
    });

    let message = if !exists {
        "That folder does not exist. Create it on the share first, or pick another.".into()
    } else if !is_dir {
        "That is a file, not a folder.".into()
    } else if !writable {
        "Folder exists but is not writable. If it is on a share, untick Read-only for that share, or choose a different destination.".into()
    } else if on_mount {
        "Writable, and on a mounted share.".into()
    } else {
        "Writable — but this is inside the container, not on a share. Anything written here is lost when the container is rebuilt.".into()
    };

    Json(PathCheck { exists, is_dir, writable, on_mount, message })
}

#[derive(Deserialize)]
struct LogQuery {
    #[serde(default)]
    level: String,
    #[serde(default)]
    contains: String,
}

async fn get_logs(State(st): State<AppState>, Query(q): Query<LogQuery>) -> Json<serde_json::Value> {
    let want = q.level.trim().to_uppercase();
    let needle = q.contains.trim().to_lowercase();
    let rank = |l: &str| match l {
        "ERROR" => 4,
        "WARN" => 3,
        "INFO" => 2,
        "DEBUG" => 1,
        _ => 0,
    };
    let min = if want.is_empty() { 0 } else { rank(&want) };

    let entries: Vec<LogEntry> = st
        .logs
        .snapshot()
        .into_iter()
        .filter(|e| rank(&e.level) >= min)
        .filter(|e| needle.is_empty() || e.message.to_lowercase().contains(&needle))
        .collect();

    Json(serde_json::json!({ "entries": entries, "capacity": LOG_CAPACITY }))
}

async fn clear_logs(State(st): State<AppState>) -> Json<serde_json::Value> {
    st.logs.clear();
    tracing::info!("log cleared from the UI");
    Json(serde_json::json!({ "ok": true }))
}

async fn health() -> &'static str {
    "ok"
}

// ---------------------------------------------------------------- main

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use tracing_subscriber::prelude::*;
    let logs = LogBuffer::default();
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "veditor_api=debug,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(CaptureLayer(logs.clone()))
        .init();

    let config_path = PathBuf::from(
        std::env::var("VEDITOR_CONFIG").unwrap_or_else(|_| "/config/settings.json".to_string()),
    );

    let settings = load_settings(&config_path).await;

    // Deliberately NO seeded roots and NO default output directory. A writable
    // location nobody chose is how you end up quietly filling a volume you
    // forgot about, and a default library root implies access that was never
    // configured. A fresh install starts with nothing and asks.
    if settings.roots.is_empty() {
        tracing::info!("no library folders configured - connect a share in Settings");
    }

    for r in &settings.roots {
        let state = if PathBuf::from(&r.path).is_dir() { "ok" } else { "MISSING" };
        tracing::info!(name = %r.name, path = %r.path, writable = r.writable, %state, "root");
    }

    let state = AppState {
        settings: Arc::new(RwLock::new(settings)),
        config_path,
        logs,
        status: Arc::new(RwLock::new(std::collections::HashMap::new())),
        sprite_jobs: Arc::new(RwLock::new(std::collections::HashSet::new())),
    };

    let cache = media::cache_root();
    if let Err(e) = std::fs::create_dir_all(&cache) {
        tracing::warn!("cache directory {} is unusable: {e}", cache.display());
    } else {
        tracing::info!("analysis cache at {}", cache.display());
    }

    // One attempt, in the background so a slow or absent NAS never delays
    // startup. If it fails the share is marked offline with the reason and left
    // alone until you press Reconnect.
    spawn_initial_mount(state.clone());

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/browse", get(browse))
        .route("/api/resolve", get(resolve_pasted))
        .route("/api/stream", get(stream))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/check-path", post(check_path))
        .route("/api/logs", get(get_logs))
        .route("/api/logs/clear", post(clear_logs))
        // ---- Phase 1: media analysis ----
        .route("/api/probe", get(media::get_probe))
        .route("/api/keyframes", get(media::get_keyframes))
        .route("/api/sprites", get(media::get_sprites))
        .route("/api/sprites/sheet", get(media::get_sprite_sheet))
        .route("/api/deep-check", post(media::deep_check))
        .route("/api/cache", get(media::cache_info))
        .route("/api/cache/clear", post(media::cache_clear))
        .route("/api/smb/mount", post(smb_mount))
        .route("/api/smb/mount-all", post(smb_mount_all))
        .route("/api/smb/unmount", post(smb_unmount))
        .route("/api/smb/test", post(smb_test))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let bind: SocketAddr = std::env::var("VEDITOR_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
        .parse()?;

    tracing::info!("listening on http://{bind}");
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
