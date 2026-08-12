//! Phase 1: media analysis.
//!
//! Three things, all cached on disk so a file is only ever analysed once:
//!   * `probe`     - codec/format facts plus an integrity verdict
//!   * `keyframes` - the timestamps a lossless cut may land on
//!   * `sprites`   - thumbnail sheets for hover-scrubbing the timeline
//!
//! Cache keys include size and mtime, so a file that changes is re-analysed
//! without anyone having to remember to clear anything.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{to_real_path, ApiError, AppState};

// ---------------------------------------------------------------- cache keys

/// Deterministic across restarts - `DefaultHasher::new()` is seeded with fixed
/// keys, unlike `RandomState`. That matters: a randomly seeded hash would miss
/// the cache on every container restart and silently re-probe everything.
pub fn cache_key(path: &Path, size: u64, mtime: u64) -> String {
    let mut h = DefaultHasher::new();
    path.to_string_lossy().hash(&mut h);
    size.hash(&mut h);
    mtime.hash(&mut h);
    format!("{:016x}", h.finish())
}

pub fn cache_root() -> PathBuf {
    PathBuf::from(std::env::var("VEDITOR_CACHE").unwrap_or_else(|_| "/cache".to_string()))
}

async fn file_stat(p: &Path) -> Result<(u64, u64), ApiError> {
    let md = tokio::fs::metadata(p).await.map_err(|_| ApiError::NotFound)?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok((md.len(), mtime))
}

/// Resolves the request path and returns (real path, cache directory for it).
async fn resolve_with_cache(st: &AppState, raw: &str) -> Result<(PathBuf, PathBuf), ApiError> {
    let p = to_real_path(st, "", raw).await?;
    if !p.is_file() {
        return Err(ApiError::Bad("not a file".into()));
    }
    let (size, mtime) = file_stat(&p).await?;
    let dir = cache_root().join(cache_key(&p, size, mtime));
    Ok((p, dir))
}

// ---------------------------------------------------------------- probe

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Finding {
    /// "error" blocks editing, "warn" is worth knowing, "info" is context.
    pub level: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioTrack {
    pub index: i64,
    pub codec: String,
    pub channels: i64,
    pub sample_rate: String,
    pub language: String,
    /// Whether a browser can be expected to decode it.
    pub browser_playable: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Probe {
    pub path: String,
    pub size: u64,
    pub container: String,
    pub duration: f64,
    pub bit_rate: u64,

    pub video_codec: String,
    pub profile: String,
    pub level: i64,
    pub width: i64,
    pub height: i64,
    pub pix_fmt: String,
    /// Nominal rate from `r_frame_rate`, e.g. 23.976023976.
    pub fps: f64,
    pub avg_fps: f64,
    pub vfr: bool,
    pub field_order: String,
    pub sar: String,
    pub color_space: String,

    pub audio: Vec<AudioTrack>,

    /// Can this file be smart-cut (frame-exact) as things stand?
    pub smartcut_ok: bool,
    /// Can the browser play it directly, without a preview transcode?
    pub browser_playable: bool,
    pub findings: Vec<Finding>,
}

fn ratio_to_f64(s: &str) -> f64 {
    let mut it = s.split('/');
    let n: f64 = it.next().unwrap_or("0").parse().unwrap_or(0.0);
    let d: f64 = it.next().unwrap_or("1").parse().unwrap_or(1.0);
    if d == 0.0 {
        0.0
    } else {
        n / d
    }
}

fn jstr(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn jint(v: &serde_json::Value, k: &str) -> i64 {
    v.get(k)
        .and_then(|x| x.as_i64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0)
}

/// Probe a real path directly, for callers that already resolved it.
pub async fn probe_path(p: &Path) -> Result<Probe, ApiError> {
    run_probe(p).await
}

/// Runs ffprobe and turns the result into facts plus an opinion.
async fn run_probe(p: &Path) -> Result<Probe, ApiError> {
    let out = tokio::process::Command::new("ffprobe")
        .args([
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(p)
        .output()
        .await
        .map_err(|e| ApiError::Internal(format!("cannot run ffprobe: {e}")))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(ApiError::Bad(format!(
            "ffprobe could not read this file: {}",
            if err.is_empty() { "no details".into() } else { err }
        )));
    }

    let root: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| ApiError::Internal(format!("ffprobe returned unreadable JSON: {e}")))?;

    let fmt = root.get("format").cloned().unwrap_or_default();
    let empty = vec![];
    let streams = root.get("streams").and_then(|s| s.as_array()).unwrap_or(&empty);

    let v = streams.iter().find(|s| jstr(s, "codec_type") == "video");
    let mut findings = Vec::new();

    let (size, _) = file_stat(p).await?;
    let duration: f64 = fmt
        .get("duration")
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse().ok())
        .unwrap_or(0.0);

    if duration <= 0.0 {
        findings.push(Finding {
            level: "error".into(),
            message: "No duration reported. The file is probably truncated or its index (moov atom) is damaged.".into(),
        });
    }

    let v = match v {
        Some(v) => v.clone(),
        None => {
            findings.push(Finding {
                level: "error".into(),
                message: "No video stream in this file.".into(),
            });
            return Ok(Probe {
                path: p.to_string_lossy().to_string(),
                size,
                container: jstr(&fmt, "format_name"),
                duration,
                bit_rate: jint(&fmt, "bit_rate").max(0) as u64,
                video_codec: String::new(), profile: String::new(), level: 0,
                width: 0, height: 0, pix_fmt: String::new(),
                fps: 0.0, avg_fps: 0.0, vfr: false,
                field_order: String::new(), sar: String::new(), color_space: String::new(),
                audio: vec![],
                smartcut_ok: false, browser_playable: false,
                findings,
            });
        }
    };

    let codec = jstr(&v, "codec_name");
    let fps = ratio_to_f64(&jstr(&v, "r_frame_rate"));
    let avg_fps = ratio_to_f64(&jstr(&v, "avg_frame_rate"));
    let field_order = jstr(&v, "field_order");

    // Variable frame rate breaks the frame-index arithmetic smart-cut relies on.
    // A small difference is just rounding; a large one is genuine VFR.
    let vfr = fps > 0.0 && avg_fps > 0.0 && ((fps - avg_fps).abs() / fps) > 0.02;
    if vfr {
        findings.push(Finding {
            level: "warn".into(),
            message: format!(
                "Variable frame rate ({:.3} nominal vs {:.3} average). Frame-exact cuts may drift; keyframe-snap cutting is unaffected.",
                fps, avg_fps
            ),
        });
    }
    if !field_order.is_empty() && field_order != "progressive" {
        findings.push(Finding {
            level: "warn".into(),
            message: format!("Interlaced source ({field_order}). Joins may show a hitch."),
        });
    }

    let container = jstr(&fmt, "format_name");
    let smartcut_ok = matches!(codec.as_str(), "h264" | "hevc") && !vfr && duration > 0.0;
    if !smartcut_ok && duration > 0.0 {
        findings.push(Finding {
            level: if matches!(codec.as_str(), "h264" | "hevc") { "warn" } else { "info" }.into(),
            message: match codec.as_str() {
                "h264" | "hevc" => "Frame-exact cutting is degraded for this file; it will fall back to keyframe-snap.".into(),
                other => format!("{other} has no MPEG-TS route, so cuts will snap to keyframes rather than being frame-exact."),
            },
        });
    }

    let audio: Vec<AudioTrack> = streams
        .iter()
        .filter(|s| jstr(s, "codec_type") == "audio")
        .map(|s| {
            let c = jstr(s, "codec_name");
            AudioTrack {
                index: jint(s, "index"),
                codec: c.clone(),
                channels: jint(s, "channels"),
                sample_rate: jstr(s, "sample_rate"),
                language: s
                    .get("tags")
                    .and_then(|t| t.get("language"))
                    .and_then(|l| l.as_str())
                    .unwrap_or("")
                    .to_string(),
                browser_playable: matches!(c.as_str(), "aac" | "mp3" | "opus" | "vorbis" | "flac"),
            }
        })
        .collect();

    // Browser playback is a separate question from whether we can edit it.
    let video_ok = matches!(codec.as_str(), "h264" | "vp8" | "vp9" | "av1")
        || (codec == "hevc"); // Safari/Edge manage HEVC; Chrome often does not
    let container_ok = container.contains("mp4") || container.contains("mov")
        || container.contains("webm");
    let audio_ok = audio.is_empty() || audio.iter().any(|a| a.browser_playable);
    let browser_playable = video_ok && container_ok && audio_ok;

    if !container_ok {
        findings.push(Finding {
            level: "info".into(),
            message: format!("{container} is not a browser container. Editing and export are unaffected; only in-page preview needs a remux."),
        });
    }
    if !audio_ok {
        let bad: Vec<String> = audio.iter().filter(|a| !a.browser_playable).map(|a| a.codec.clone()).collect();
        findings.push(Finding {
            level: "info".into(),
            message: format!("Audio ({}) will not play in the browser. Export keeps it untouched.", bad.join(", ")),
        });
    }
    if codec == "hevc" {
        findings.push(Finding {
            level: "info".into(),
            message: "HEVC preview depends on the browser — Safari and Edge usually manage it, Chrome often will not.".into(),
        });
    }

    Ok(Probe {
        path: p.to_string_lossy().to_string(),
        size,
        container,
        duration,
        bit_rate: jint(&fmt, "bit_rate").max(0) as u64,
        video_codec: codec,
        profile: jstr(&v, "profile"),
        level: jint(&v, "level"),
        width: jint(&v, "width"),
        height: jint(&v, "height"),
        pix_fmt: jstr(&v, "pix_fmt"),
        fps,
        avg_fps,
        vfr,
        field_order,
        sar: jstr(&v, "sample_aspect_ratio"),
        color_space: jstr(&v, "color_space"),
        audio,
        smartcut_ok,
        browser_playable,
        findings,
    })
}

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: String,
    #[serde(default)]
    pub refresh: bool,
    /// Cache-only: report what already exists and never start a build.
    ///
    /// Building sprites reads the whole file, which over a network share is the
    /// single most expensive thing this app does. It must never happen as a side
    /// effect of merely selecting a file.
    #[serde(default)]
    pub peek: bool,
}

pub async fn get_probe(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<Json<Probe>, ApiError> {
    let (p, dir) = resolve_with_cache(&st, &q.path).await?;
    let file = dir.join("probe.json");

    if !q.refresh {
        if let Ok(s) = tokio::fs::read_to_string(&file).await {
            if let Ok(v) = serde_json::from_str::<Probe>(&s) {
                return Ok(Json(v));
            }
        }
    }

    let probe = run_probe(&p).await?;
    let _ = tokio::fs::create_dir_all(&dir).await;
    if let Ok(j) = serde_json::to_string(&probe) {
        let _ = tokio::fs::write(&file, j).await;
    }
    tracing::info!(
        "probed {} ({}x{} {} {:.3}fps)",
        p.display(), probe.width, probe.height, probe.video_codec, probe.fps
    );
    Ok(Json(probe))
}

// ---------------------------------------------------------------- keyframes

#[derive(Serialize, Deserialize)]
pub struct Keyframes {
    pub times: Vec<f64>,
    /// Mean gap between keyframes - a good proxy for how far a keyframe-snap
    /// cut could land from where you clicked.
    pub avg_gap: f64,
    pub max_gap: f64,
    pub took_ms: u64,
}

/// Keyframe timestamps for a path, from cache when possible.
///
/// Shared with the export engine, which needs them to snap cut points onto
/// stream-copy boundaries. Exposed separately so a job never has to go back out
/// through HTTP to get at its own process's cache.
pub async fn load_keyframes(st: &AppState, raw: &str) -> Result<Vec<f64>, ApiError> {
    let q = PathQuery { path: raw.to_string(), refresh: false, peek: false };
    let kf = get_keyframes(State(st.clone()), Query(q)).await?;
    Ok(kf.0.times)
}

pub async fn get_keyframes(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<Json<Keyframes>, ApiError> {
    let (p, dir) = resolve_with_cache(&st, &q.path).await?;
    let file = dir.join("keyframes.json");

    if !q.refresh {
        if let Ok(s) = tokio::fs::read_to_string(&file).await {
            if let Ok(v) = serde_json::from_str::<Keyframes>(&s) {
                return Ok(Json(v));
            }
        }
    }

    let t0 = std::time::Instant::now();
    // Demux only, no decoding: even a two-hour file takes a couple of seconds.
    let out = tokio::process::Command::new("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "packet=pts_time,flags",
            "-of", "csv=p=0",
        ])
        .arg(&p)
        .output()
        .await
        .map_err(|e| ApiError::Internal(format!("cannot run ffprobe: {e}")))?;

    if !out.status.success() {
        return Err(ApiError::Bad(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }

    let mut times: Vec<f64> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains(",K"))
        .filter_map(|l| l.split(',').next().and_then(|t| t.parse::<f64>().ok()))
        .collect();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let gaps: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    let avg_gap = if gaps.is_empty() { 0.0 } else { gaps.iter().sum::<f64>() / gaps.len() as f64 };
    let max_gap = gaps.iter().cloned().fold(0.0, f64::max);

    let kf = Keyframes {
        times,
        avg_gap,
        max_gap,
        took_ms: t0.elapsed().as_millis() as u64,
    };
    let _ = tokio::fs::create_dir_all(&dir).await;
    if let Ok(j) = serde_json::to_string(&kf) {
        let _ = tokio::fs::write(&file, j).await;
    }
    tracing::info!(
        "indexed {} keyframes in {} ({:.1}s average gap)",
        kf.times.len(), p.display(), kf.avg_gap
    );
    Ok(Json(kf))
}

// ---------------------------------------------------------------- sprites

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct SpriteIndex {
    /// Seconds between thumbnails.
    pub interval: f64,
    pub tile_w: i64,
    pub tile_h: i64,
    pub cols: i64,
    pub rows: i64,
    /// Number of sheets written so far.
    pub sheets: i64,
    /// Total thumbnails expected.
    pub count: i64,
    pub done: bool,
    #[serde(default)]
    pub error: String,
}

const COLS: i64 = 10;
const ROWS: i64 = 10;
const TILE_W: i64 = 160;

fn sprite_dir(cache: &Path) -> PathBuf {
    cache.join("sprites")
}

/// Picks an interval that yields a useful number of thumbnails without
/// producing thousands of sheets for a long film.
fn pick_interval(duration: f64) -> f64 {
    let target = 900.0; // aim for ~900 thumbnails
    let raw = duration / target;
    [1.0, 2.0, 5.0, 10.0, 15.0, 30.0]
        .into_iter()
        .find(|&s| s >= raw)
        .unwrap_or(60.0)
}

async fn build_sprites(p: PathBuf, dir: PathBuf, probe: Probe) {
    let sdir = sprite_dir(&dir);
    let _ = tokio::fs::create_dir_all(&sdir).await;

    let interval = pick_interval(probe.duration);
    let tile_h = if probe.width > 0 {
        let h = (TILE_W as f64 * probe.height as f64 / probe.width as f64).round() as i64;
        if h % 2 == 0 { h } else { h + 1 }
    } else {
        90
    };
    let count = ((probe.duration / interval).ceil() as i64).max(1);

    let mut index = SpriteIndex {
        interval, tile_w: TILE_W, tile_h, cols: COLS, rows: ROWS,
        sheets: 0, count, done: false, error: String::new(),
    };
    let write_index = |ix: &SpriteIndex| {
        let path = dir.join("sprites.json");
        let json = serde_json::to_string(ix).unwrap_or_default();
        std::fs::write(path, json).ok();
    };
    write_index(&index);

    // `-skip_frame nokey` makes the decoder emit only keyframes, so a two-hour
    // 1080p file is scanned in a minute or two instead of many. The fps filter
    // then resamples those onto a regular grid.
    let vf = format!(
        "fps=1/{interval},scale={TILE_W}:{tile_h}:force_original_aspect_ratio=decrease,pad={TILE_W}:{tile_h}:(ow-iw)/2:(oh-ih)/2,tile={COLS}x{ROWS}"
    );
    let pattern = sdir.join("sheet_%04d.jpg");

    let t0 = std::time::Instant::now();
    let out = tokio::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-skip_frame", "nokey"])
        .arg("-i").arg(&p)
        .args(["-an", "-sn", "-vf", &vf, "-fps_mode", "passthrough", "-q:v", "5"])
        .arg(&pattern)
        .output()
        .await;

    match out {
        Ok(o) if o.status.success() => {
            let mut n = 0i64;
            if let Ok(mut rd) = tokio::fs::read_dir(&sdir).await {
                while let Ok(Some(e)) = rd.next_entry().await {
                    if e.file_name().to_string_lossy().starts_with("sheet_") {
                        n += 1;
                    }
                }
            }
            index.sheets = n;
            index.done = true;
            write_index(&index);
            tracing::info!(
                "built {} sprite sheet(s) for {} in {:.1}s (every {}s)",
                n, p.display(), t0.elapsed().as_secs_f64(), interval
            );
        }
        Ok(o) => {
            index.error = String::from_utf8_lossy(&o.stderr).trim().to_string();
            index.done = true;
            write_index(&index);
            tracing::warn!("sprite build failed for {}: {}", p.display(), index.error);
        }
        Err(e) => {
            index.error = format!("could not run ffmpeg: {e}");
            index.done = true;
            write_index(&index);
            tracing::warn!("sprite build failed for {}: {}", p.display(), index.error);
        }
    }
}

/// Returns the sprite index, kicking off generation if it has not been built.
pub async fn get_sprites(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<Json<SpriteIndex>, ApiError> {
    let (p, dir) = resolve_with_cache(&st, &q.path).await?;
    let ifile = dir.join("sprites.json");

    if !q.refresh {
        if let Ok(s) = tokio::fs::read_to_string(&ifile).await {
            if let Ok(v) = serde_json::from_str::<SpriteIndex>(&s) {
                return Ok(Json(v));
            }
        }
    }

    if q.peek {
        // Nothing cached and the caller only wanted to look.
        return Ok(Json(SpriteIndex { done: false, ..Default::default() }));
    }

    // Not built (or a rebuild was asked for): start one and report "in progress"
    // immediately, so the UI can fill the timeline in as sheets land.
    {
        let mut running = st.sprite_jobs.write().await;
        if running.contains(&p) {
            return Ok(Json(SpriteIndex { done: false, ..Default::default() }));
        }
        running.insert(p.clone());
    }

    let probe = run_probe(&p).await?;
    let _ = tokio::fs::create_dir_all(&dir).await;
    if q.refresh {
        let _ = tokio::fs::remove_dir_all(sprite_dir(&dir)).await;
    }

    let st2 = st.clone();
    let p2 = p.clone();
    tokio::spawn(async move {
        build_sprites(p2.clone(), dir, probe).await;
        st2.sprite_jobs.write().await.remove(&p2);
    });

    Ok(Json(SpriteIndex { done: false, ..Default::default() }))
}

#[derive(Deserialize)]
pub struct SheetQuery {
    pub path: String,
    pub n: i64,
}

/// Serves one sprite sheet. Cached hard - the content is immutable for a given
/// cache key, and the key already includes size and mtime.
pub async fn get_sprite_sheet(
    State(st): State<AppState>,
    Query(q): Query<SheetQuery>,
) -> Result<axum::response::Response, ApiError> {
    use axum::http::header;
    use axum::response::IntoResponse;

    let (_p, dir) = resolve_with_cache(&st, &q.path).await?;
    let file = sprite_dir(&dir).join(format!("sheet_{:04}.jpg", q.n));
    let bytes = tokio::fs::read(&file).await.map_err(|_| ApiError::NotFound)?;

    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response())
}

// ---------------------------------------------------------------- poster

/// One representative frame, cached.
///
/// Cheap on purpose: seek first, decode a single frame, stop. Unlike the sprite
/// sheets this does not scan the file, so it is safe to call for every row of a
/// folder listing.
pub async fn get_poster(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<axum::response::Response, ApiError> {
    use axum::http::header;
    use axum::response::IntoResponse;

    let (p, dir) = resolve_with_cache(&st, &q.path).await?;
    let file = dir.join("poster.jpg");

    if !q.refresh {
        if let Ok(b) = tokio::fs::read(&file).await {
            return Ok((
                [(header::CONTENT_TYPE, "image/jpeg"),
                 (header::CACHE_CONTROL, "public, max-age=31536000, immutable")],
                b,
            ).into_response());
        }
    }

    let _ = tokio::fs::create_dir_all(&dir).await;
    // 10% in avoids black leader and logo cards without a full probe first.
    let out = tokio::process::Command::new("ffmpeg")
        // -noaccurate_seek lands on the nearest keyframe instead of decoding
        // forward to an exact timestamp. For a thumbnail the difference is
        // invisible and it is dramatically cheaper on a 4K file over a share.
        .args(["-hide_banner", "-loglevel", "error", "-y", "-noaccurate_seek", "-ss", "60"])
        .arg("-i").arg(&p)
        .args(["-frames:v", "1", "-vf", "scale=240:-2", "-q:v", "4"])
        .arg(&file)
        .output()
        .await
        .map_err(|e| ApiError::Internal(format!("cannot run ffmpeg: {e}")))?;

    if !out.status.success() || !file.exists() {
        // Short clip? Try the very beginning before giving up.
        let _ = tokio::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .arg("-i").arg(&p)
            .args(["-frames:v", "1", "-vf", "scale=240:-2", "-q:v", "4"])
            .arg(&file)
            .output()
            .await;
    }

    let bytes = tokio::fs::read(&file).await.map_err(|_| ApiError::NotFound)?;
    Ok((
        [(header::CONTENT_TYPE, "image/jpeg"),
         (header::CACHE_CONTROL, "public, max-age=31536000, immutable")],
        bytes,
    ).into_response())
}

// ---------------------------------------------------------------- waveform

#[derive(Serialize, Deserialize, Default)]
pub struct Waveform {
    /// Peak amplitude per bucket, 0..1.
    pub peaks: Vec<f32>,
    pub buckets: usize,
    pub duration: f64,
    pub took_ms: u64,
}

const WAVE_BUCKETS: usize = 1800;

/// Peak envelope of the audio, for spotting silence and scene changes by eye.
///
/// Opt-in like the thumbnails, and for the same reason: decoding the audio means
/// reading the whole file, which over a share is the expensive thing. The result
/// though is tiny — under 20 kB — so it is cached rather than regenerated, since
/// throwing it away would mean paying that read again. "Clear cache" removes it
/// along with everything else.
pub async fn get_waveform(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<Json<Waveform>, ApiError> {
    use tokio::io::AsyncReadExt;

    let (p, dir) = resolve_with_cache(&st, &q.path).await?;
    let file = dir.join("waveform.json");

    if !q.refresh {
        if let Ok(s) = tokio::fs::read_to_string(&file).await {
            if let Ok(v) = serde_json::from_str::<Waveform>(&s) {
                return Ok(Json(v));
            }
        }
    }
    if q.peek {
        return Ok(Json(Waveform::default()));
    }

    let probe = run_probe(&p).await?;
    if probe.audio.is_empty() {
        return Err(ApiError::Bad("this file has no audio".into()));
    }

    let t0 = std::time::Instant::now();
    // Mono, 8 kHz, raw 16-bit: enough to draw an envelope, ~2 MB per minute
    // streamed through a pipe rather than written anywhere.
    let mut child = tokio::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-v", "error", "-nostdin"])
        .arg("-i").arg(&p)
        .args(["-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| ApiError::Internal(format!("cannot run ffmpeg: {e}")))?;

    let mut out = child.stdout.take().ok_or_else(|| ApiError::Internal("no output".into()))?;
    let total_samples = (probe.duration * 8000.0).max(1.0);
    let per_bucket = (total_samples / WAVE_BUCKETS as f64).max(1.0);

    let mut peaks = vec![0f32; WAVE_BUCKETS];
    let mut buf = vec![0u8; 64 * 1024];
    let mut sample_index = 0f64;

    loop {
        let n = out.read(&mut buf).await.map_err(|e| ApiError::Internal(e.to_string()))?;
        if n == 0 {
            break;
        }
        for chunk in buf[..n].chunks_exact(2) {
            let v = i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0;
            let b = ((sample_index / per_bucket) as usize).min(WAVE_BUCKETS - 1);
            let a = v.abs();
            if a > peaks[b] {
                peaks[b] = a;
            }
            sample_index += 1.0;
        }
    }
    let _ = child.wait().await;

    let wf = Waveform {
        buckets: WAVE_BUCKETS,
        duration: probe.duration,
        took_ms: t0.elapsed().as_millis() as u64,
        peaks,
    };
    let _ = tokio::fs::create_dir_all(&dir).await;
    if let Ok(j) = serde_json::to_string(&wf) {
        let _ = tokio::fs::write(&file, j).await;
    }
    tracing::info!("waveform for {} in {:.1}s", p.display(), t0.elapsed().as_secs_f64());
    Ok(Json(wf))
}

// ---------------------------------------------------------------- deep check

#[derive(Serialize)]
pub struct DeepCheck {
    pub ok: bool,
    pub errors: Vec<String>,
    pub checked_seconds: f64,
    pub took_ms: u64,
}

#[derive(Deserialize)]
pub struct DeepQuery {
    pub path: String,
}

/// Decodes the first and last 20 seconds looking for real errors.
///
/// Deliberately not automatic: a full decode of a two-hour file costs minutes,
/// and truncation damage almost always shows up at the tail. This is the button
/// you press when a file looks suspicious.
pub async fn deep_check(
    State(st): State<AppState>,
    Json(q): Json<DeepQuery>,
) -> Result<Json<DeepCheck>, ApiError> {
    let p = to_real_path(&st, "", &q.path).await?;
    let t0 = std::time::Instant::now();
    let mut errors = Vec::new();
    let window = 20.0f64;

    // Head.
    let head = tokio::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-v", "error", "-t", "20"])
        .arg("-i").arg(&p)
        .args(["-f", "null", "-"])
        .output()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let h = String::from_utf8_lossy(&head.stderr).trim().to_string();
    if !h.is_empty() {
        errors.extend(h.lines().take(5).map(|l| format!("start: {l}")));
    }

    // Tail - where truncation actually bites.
    let tail = tokio::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-v", "error", "-sseof", "-20"])
        .arg("-i").arg(&p)
        .args(["-f", "null", "-"])
        .output()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let t = String::from_utf8_lossy(&tail.stderr).trim().to_string();
    if !t.is_empty() {
        errors.extend(t.lines().take(5).map(|l| format!("end: {l}")));
    }

    let ok = errors.is_empty();
    tracing::info!(
        "deep check {}: {}",
        p.display(),
        if ok { "clean".to_string() } else { format!("{} problem(s)", errors.len()) }
    );

    Ok(Json(DeepCheck {
        ok,
        errors,
        checked_seconds: window * 2.0,
        took_ms: t0.elapsed().as_millis() as u64,
    }))
}

// ---------------------------------------------------------------- cache admin

#[derive(Serialize)]
pub struct CacheInfo {
    pub path: String,
    pub entries: usize,
    pub bytes: u64,
}

pub async fn cache_info(State(_st): State<AppState>) -> Json<CacheInfo> {
    let root = cache_root();
    let mut entries = 0usize;
    let mut bytes = 0u64;

    fn walk(dir: &Path, entries: &mut usize, bytes: &mut u64, top: bool) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    if top {
                        *entries += 1;
                    }
                    walk(&p, entries, bytes, false);
                } else if let Ok(md) = e.metadata() {
                    *bytes += md.len();
                }
            }
        }
    }
    walk(&root, &mut entries, &mut bytes, true);

    Json(CacheInfo { path: root.to_string_lossy().to_string(), entries, bytes })
}

pub async fn cache_clear(State(_st): State<AppState>) -> Json<serde_json::Value> {
    let root = cache_root();
    let mut removed = 0;
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            if e.path().is_dir() && std::fs::remove_dir_all(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    tracing::info!("cache cleared: {removed} entries removed");
    Json(serde_json::json!({ "ok": true, "removed": removed }))
}
