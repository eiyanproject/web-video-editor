//! Phase 3 export engine: keyframe-snap cutting, joining and container remux.
//!
//! Everything here is a **stream copy**. Cut points are snapped onto keyframes
//! so no frame is ever re-encoded, which makes an export as fast as the disk or
//! the network will go. Frame-exact cutting (smart-cut) arrives in Phase 4 and
//! will reuse this job machinery.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    extract::{Path as AxPath, State},
    Json,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};

use crate::{media, to_real_path, ApiError, AppState};

// ---------------------------------------------------------------- request

#[derive(Clone, Debug, Deserialize)]
pub struct Seg {
    pub start: f64,
    pub end: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ExportRequest {
    pub source: String,
    /// Kept segments in order. Excluded ones are simply absent.
    pub segments: Vec<Seg>,
    /// "merge" - one file; "separate" - one file per segment.
    #[serde(default = "merge")]
    pub mode: String,
    /// Target container extension without the dot. Empty keeps the source's.
    #[serde(default)]
    pub container: String,
    pub output_dir: String,
    #[serde(default)]
    pub basename: String,
    /// Overwrite an existing output instead of refusing.
    #[serde(default)]
    pub overwrite: bool,
}

fn merge() -> String {
    "merge".into()
}

// ---------------------------------------------------------------- job state

#[derive(Clone, Debug, Serialize)]
pub struct SnapNote {
    pub requested_start: f64,
    pub requested_end: f64,
    pub actual_start: f64,
    pub actual_end: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Job {
    pub id: String,
    pub source: String,
    pub mode: String,
    /// queued | running | done | failed | cancelled
    pub status: String,
    pub progress: f64,
    pub message: String,
    pub outputs: Vec<String>,
    pub started_at: u64,
    pub finished_at: u64,
    pub total_seconds: f64,
    pub snapped: Vec<SnapNote>,
    pub verified: bool,
}

#[derive(Clone, Default)]
pub struct Jobs {
    pub map: Arc<RwLock<HashMap<String, Job>>>,
    /// Running ffmpeg processes, so a job can actually be stopped.
    procs: Arc<Mutex<HashMap<String, tokio::process::Child>>>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Jobs {
    async fn set<F: FnOnce(&mut Job)>(&self, id: &str, f: F) {
        if let Some(j) = self.map.write().await.get_mut(id) {
            f(j);
        }
    }
}

// ---------------------------------------------------------------- snapping

/// Nearest keyframe to `t`. With no index at all we cannot snap, so the caller
/// falls back to the requested time and ffmpeg will land on the preceding
/// keyframe by itself.
fn nearest(t: f64, kf: &[f64]) -> f64 {
    if kf.is_empty() {
        return t;
    }
    let mut lo = 0usize;
    let mut hi = kf.len() - 1;
    while lo < hi {
        let mid = (lo + hi) / 2;
        if kf[mid] < t { lo = mid + 1 } else { hi = mid }
    }
    let b = kf[lo];
    let a = kf[lo.saturating_sub(1)];
    if (t - a).abs() <= (b - t).abs() { a } else { b }
}

// ---------------------------------------------------------------- ffmpeg

/// Audio bitstream fixes needed when changing container.
///
/// AAC inside MPEG-TS is ADTS-framed; MP4 needs an AudioSpecificConfig instead.
/// Omitting this is the single most common cause of an MP4 that plays with no
/// sound, and it fails silently, so it is applied whenever it could matter.
fn audio_bsf(src_container: &str, target_ext: &str, audio_codec: &str) -> Option<&'static str> {
    let to_mp4 = matches!(target_ext, "mp4" | "m4v" | "mov");
    if to_mp4 && audio_codec == "aac" && src_container.contains("mpegts") {
        Some("aac_adtstoasc")
    } else {
        None
    }
}

/// ffmpeg infers the muxer from the output extension, and we deliberately write
/// to `<name>.<ext>.part` first so a killed job never leaves a plausible-looking
/// broken file. That hides the real extension, so the muxer must be named.
fn muxer_for(ext: &str) -> &'static str {
    match ext {
        "mkv" => "matroska",
        "ts" | "m2ts" | "mts" => "mpegts",
        "mov" => "mov",
        "webm" => "webm",
        "avi" => "avi",
        "m4v" | "mp4" => "mp4",
        _ => "mp4",
    }
}

fn out_ext(req: &ExportRequest, source: &Path) -> String {
    if !req.container.trim().is_empty() {
        return req.container.trim().trim_start_matches('.').to_lowercase();
    }
    source
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "mp4".into())
}

/// Runs one ffmpeg, streaming `-progress` so the UI has something honest to
/// show on a job that can take minutes over a network share.
async fn run_ffmpeg(
    jobs: &Jobs,
    id: &str,
    args: Vec<String>,
    base_done: f64,
    slice: f64,
    total: f64,
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = tokio::process::Command::new("ffmpeg")
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start ffmpeg: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    jobs.procs.lock().await.insert(id.to_string(), child);

    // stderr is drained in the background: a full pipe buffer would deadlock
    // ffmpeg, and its last lines are the only useful error message.
    let err_handle = tokio::spawn(async move {
        let mut tail = Vec::new();
        if let Some(e) = stderr {
            let mut lines = BufReader::new(e).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                tail.push(l);
                if tail.len() > 40 {
                    tail.remove(0);
                }
            }
        }
        tail
    });

    if let Some(out) = stdout {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if let Some(v) = l.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<f64>() {
                    if total > 0.0 {
                        let frac = (us / 1e6 / total).clamp(0.0, 1.0);
                        jobs.set(id, |j| j.progress = (base_done + frac * slice).clamp(0.0, 1.0)).await;
                    }
                }
            }
        }
    }

    let mut child = jobs
        .procs
        .lock()
        .await
        .remove(id)
        .ok_or_else(|| "job was cancelled".to_string())?;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let tail = err_handle.await.unwrap_or_default();

    if status.success() {
        Ok(())
    } else {
        let msg = tail
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| format!("ffmpeg exited with {status}"));
        Err(msg)
    }
}

/// Duration check on the result. A copy job that silently produced three
/// seconds of video is worse than one that failed outright.
async fn verify(path: &Path, expected: f64) -> (bool, String) {
    let out = tokio::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .await;
    let Ok(o) = out else { return (false, "could not probe the output".into()) };
    let got: f64 = String::from_utf8_lossy(&o.stdout).trim().parse().unwrap_or(0.0);
    if got <= 0.0 {
        return (false, "output has no duration - it is probably broken".into());
    }
    let drift = (got - expected).abs();
    if drift > expected * 0.02 + 1.0 {
        (false, format!("expected ~{expected:.1}s but got {got:.1}s"))
    } else {
        (true, format!("{got:.1}s"))
    }
}

// ---------------------------------------------------------------- the job

async fn run_export(st: AppState, id: String, req: ExportRequest) {
    let jobs = st.jobs.clone();
    let fail = |msg: String| {
        let jobs = jobs.clone();
        let id = id.clone();
        async move {
            tracing::warn!("export {id} failed: {msg}");
            jobs.set(&id, |j| {
                j.status = "failed".into();
                j.message = msg;
                j.finished_at = now();
            })
            .await;
        }
    };

    let src = match to_real_path(&st, "", &req.source).await {
        Ok(p) => p,
        Err(_) => return fail("source file not found".into()).await,
    };

    let probe = match media::probe_path(&src).await {
        Ok(p) => p,
        Err(e) => return fail(format!("cannot read the source: {e:?}")).await,
    };

    // Snap every boundary onto a keyframe. This is what makes the whole export a
    // pure copy; the UI has already shown the user where these land.
    let kf = media::load_keyframes(&st, &req.source).await.unwrap_or_default();
    let mut segs = Vec::new();
    let mut notes = Vec::new();
    for s in &req.segments {
        let a = nearest(s.start, &kf).max(0.0);
        let b = if (s.end - probe.duration).abs() < 0.05 { s.end } else { nearest(s.end, &kf) };
        if b - a < 0.05 {
            continue;
        }
        notes.push(SnapNote {
            requested_start: s.start,
            requested_end: s.end,
            actual_start: a,
            actual_end: b,
        });
        segs.push((a, b));
    }
    if segs.is_empty() {
        return fail("nothing to export - every segment is excluded or too short".into()).await;
    }

    let total: f64 = segs.iter().map(|(a, b)| b - a).sum();
    let ext = out_ext(&req, &src);
    let stem = if req.basename.trim().is_empty() {
        src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "output".into())
    } else {
        req.basename.trim().to_string()
    };
    let outdir = PathBuf::from(req.output_dir.trim());

    if let Err(e) = tokio::fs::create_dir_all(&outdir).await {
        return fail(format!("cannot use the output folder: {e}")).await;
    }
    // Writability is checked properly rather than trusting permission bits,
    // which lie on network filesystems.
    let probe_file = outdir.join(".wve-write-test");
    if tokio::fs::write(&probe_file, b"x").await.is_err() {
        return fail(format!("{} is not writable", outdir.display())).await;
    }
    let _ = tokio::fs::remove_file(&probe_file).await;

    let bsf = audio_bsf(
        &probe.container,
        &ext,
        probe.audio.first().map(|a| a.codec.as_str()).unwrap_or(""),
    );

    jobs.set(&id, |j| {
        j.status = "running".into();
        j.total_seconds = total;
        j.snapped = notes.clone();
        j.message = format!("copying {:.0}s", total);
    })
    .await;

    let mut outputs: Vec<String> = Vec::new();

    let result: Result<(), String> = if req.mode == "separate" || req.mode == "separate_merge" {
        let mut acc = Ok(());
        for (i, (a, b)) in segs.iter().enumerate() {
            let target = outdir.join(format!("{stem}_seg{:02}.{ext}", i + 1));
            if target.exists() && !req.overwrite {
                acc = Err(format!("{} already exists", target.display()));
                break;
            }
            let part = target.with_extension(format!("{ext}.part"));
            let mut args: Vec<String> = vec![
                "-hide_banner".into(), "-nostdin".into(), "-y".into(),
                "-ss".into(), format!("{a:.3}"),
                "-i".into(), src.to_string_lossy().to_string(),
                "-t".into(), format!("{:.3}", b - a),
                "-c".into(), "copy".into(),
                "-avoid_negative_ts".into(), "make_zero".into(),
                "-map".into(), "0".into(),
                "-map_metadata".into(), "0".into(),
            ];
            if let Some(f) = bsf { args.push("-bsf:a".into()); args.push(f.into()); }
            if matches!(ext.as_str(), "mp4" | "m4v" | "mov") {
                args.push("-movflags".into());
                args.push("+faststart".into());
            }
            args.push("-f".into()); args.push(muxer_for(&ext).into());
            args.push("-progress".into()); args.push("pipe:1".into());
            args.push("-nostats".into());
            args.push(part.to_string_lossy().to_string());

            let base = i as f64 / segs.len() as f64;
            let slice = 1.0 / segs.len() as f64;
            if let Err(e) = run_ffmpeg(&jobs, &id, args, base, slice, b - a).await {
                let _ = tokio::fs::remove_file(&part).await;
                acc = Err(e);
                break;
            }
            if tokio::fs::rename(&part, &target).await.is_err() {
                acc = Err(format!("cannot finalise {}", target.display()));
                break;
            }
            outputs.push(target.to_string_lossy().to_string());
        }

        // "separate_merge": join the finished pieces afterwards.
        //
        // A direct concat of byte ranges from one source is faster, but it asks
        // the muxer to stitch across discontinuities in a single pass, and some
        // files come out wrong that way. Writing each piece as a complete,
        // independently valid file and then joining those is slower and uses
        // more disk, but it is markedly more robust - which is exactly the
        // fallback to reach for when a single-file export misbehaves.
        if acc.is_ok() && req.mode == "separate_merge" && outputs.len() > 1 {
            let joined = outdir.join(format!("{stem}_joined.{ext}"));
            if joined.exists() && !req.overwrite {
                acc = Err(format!("{} already exists", joined.display()));
            } else {
                let list = outdir.join(format!(".{stem}.join.txt"));
                let body: String = outputs
                    .iter()
                    .map(|o| format!("file '{}'\n", o.replace('\'', "'\\''")))
                    .collect();
                if tokio::fs::write(&list, body).await.is_err() {
                    acc = Err("cannot write the join list".into());
                } else {
                    let part = joined.with_extension(format!("{ext}.part"));
                    let mut args: Vec<String> = vec![
                        "-hide_banner".into(), "-nostdin".into(), "-y".into(),
                        "-fflags".into(), "+genpts".into(),
                        "-f".into(), "concat".into(), "-safe".into(), "0".into(),
                        "-i".into(), list.to_string_lossy().to_string(),
                        "-c".into(), "copy".into(),
                        "-avoid_negative_ts".into(), "make_zero".into(),
                        "-max_interleave_delta".into(), "0".into(),
                        "-muxdelay".into(), "0".into(), "-muxpreload".into(), "0".into(),
                    ];
                    if matches!(ext.as_str(), "mp4" | "m4v" | "mov") {
                        args.push("-movflags".into()); args.push("+faststart".into());
                    }
                    args.push("-f".into()); args.push(muxer_for(&ext).into());
                    args.push("-progress".into()); args.push("pipe:1".into());
                    args.push("-nostats".into());
                    args.push(part.to_string_lossy().to_string());

                    match run_ffmpeg(&jobs, &id, args, 0.9, 0.1, total).await {
                        Err(e) => { let _ = tokio::fs::remove_file(&part).await; acc = Err(e); }
                        Ok(()) => {
                            if tokio::fs::rename(&part, &joined).await.is_ok() {
                                // The per-segment files were a means to an end -
                                // this mode exists because joining complete files
                                // is more reliable, not because anyone wants the
                                // pieces. Only delete them once the join has
                                // actually succeeded.
                                for f in &outputs {
                                    let _ = tokio::fs::remove_file(f).await;
                                }
                                outputs.clear();
                                outputs.push(joined.to_string_lossy().to_string());
                            } else {
                                acc = Err(format!("cannot finalise {}", joined.display()));
                            }
                        }
                    }
                    let _ = tokio::fs::remove_file(&list).await;
                }
            }
        }
        acc
    } else {
        let target = outdir.join(format!("{stem}_cut.{ext}"));
        if target.exists() && !req.overwrite {
            Err(format!("{} already exists", target.display()))
        } else {
            // The concat demuxer reads byte ranges of the original in place, so
            // the kept sections are never copied to a temp file first. One read,
            // one write - which matters when both are over the network.
            let list = outdir.join(format!(".{stem}.concat.txt"));
            let mut body = String::new();
            for (a, b) in &segs {
                body.push_str(&format!(
                    "file '{}'\ninpoint {a:.3}\noutpoint {b:.3}\n",
                    src.to_string_lossy().replace('\'', "'\\''")
                ));
            }
            let write = tokio::fs::write(&list, body).await;
            if write.is_err() {
                Err("cannot write the concat list".to_string())
            } else {
                let part = target.with_extension(format!("{ext}.part"));
                let mut args: Vec<String> = vec![
                    "-hide_banner".into(), "-nostdin".into(), "-y".into(),
                    // Each concat piece restarts its timestamps, so without
                    // regenerated PTS the muxer sees them go backwards at every
                    // join. That produces a file which plays, but stutters or
                    // desyncs at the cuts in stricter players.
                    "-fflags".into(), "+genpts".into(),
                    "-f".into(), "concat".into(),
                    "-safe".into(), "0".into(),
                    "-i".into(), list.to_string_lossy().to_string(),
                    "-c".into(), "copy".into(),
                    "-avoid_negative_ts".into(), "make_zero".into(),
                    "-max_interleave_delta".into(), "0".into(),
                    "-muxdelay".into(), "0".into(),
                    "-muxpreload".into(), "0".into(),
                ];
                if let Some(f) = bsf { args.push("-bsf:a".into()); args.push(f.into()); }
                if matches!(ext.as_str(), "mp4" | "m4v" | "mov") {
                    args.push("-movflags".into());
                    args.push("+faststart".into());
                }
                args.push("-f".into()); args.push(muxer_for(&ext).into());
                args.push("-progress".into()); args.push("pipe:1".into());
                args.push("-nostats".into());
                args.push(part.to_string_lossy().to_string());

                let r = run_ffmpeg(&jobs, &id, args, 0.0, 1.0, total).await;
                let _ = tokio::fs::remove_file(&list).await;
                match r {
                    Err(e) => { let _ = tokio::fs::remove_file(&part).await; Err(e) }
                    Ok(()) => match tokio::fs::rename(&part, &target).await {
                        Err(_) => Err(format!("cannot finalise {}", target.display())),
                        Ok(()) => { outputs.push(target.to_string_lossy().to_string()); Ok(()) }
                    },
                }
            }
        }
    };

    match result {
        Err(e) => {
            let cancelled = e.contains("cancelled");
            jobs.set(&id, |j| {
                j.status = if cancelled { "cancelled".into() } else { "failed".into() };
                j.message = e;
                j.finished_at = now();
                j.outputs = outputs.clone();
            })
            .await;
        }
        Ok(()) => {
            let expected = if req.mode == "separate" {
                segs.first().map(|(a, b)| b - a).unwrap_or(total)
            } else {
                // merge and separate_merge both put the whole thing first.
                total
            };
            let (ok, detail) = match outputs.first() {
                Some(f) => verify(Path::new(f), expected).await,
                None => (false, "no output produced".into()),
            };
            tracing::info!(
                "export {id} finished: {} file(s), {:.1}s, verify {}",
                outputs.len(), total, if ok { "ok" } else { "FAILED" }
            );
            jobs.set(&id, |j| {
                j.status = if ok { "done".into() } else { "failed".into() };
                j.progress = 1.0;
                j.verified = ok;
                j.outputs = outputs.clone();
                j.finished_at = now();
                j.message = if ok {
                    format!("{} file(s) written · {detail}", outputs.len())
                } else {
                    format!("output failed verification: {detail}")
                };
            })
            .await;
        }
    }
}

// ---------------------------------------------------------------- handlers

pub async fn start_export(
    State(st): State<AppState>,
    Json(req): Json<ExportRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if req.segments.is_empty() {
        return Err(ApiError::Bad("no segments to export".into()));
    }
    if req.output_dir.trim().is_empty() {
        return Err(ApiError::Bad("no output folder set - Settings → Export destination".into()));
    }

    let id = format!("{:x}", now() as u128 * 1000 + (rand_suffix() as u128));
    let job = Job {
        id: id.clone(),
        source: req.source.clone(),
        mode: req.mode.clone(),
        status: "queued".into(),
        progress: 0.0,
        message: "queued".into(),
        outputs: vec![],
        started_at: now(),
        finished_at: 0,
        total_seconds: 0.0,
        snapped: vec![],
        verified: false,
    };
    st.jobs.map.write().await.insert(id.clone(), job);
    tracing::info!("export {id} queued: {} ({} segments)", req.source, req.segments.len());

    let st2 = st.clone();
    let id2 = id.clone();
    tokio::spawn(async move { run_export(st2, id2, req).await });

    Ok(Json(serde_json::json!({ "id": id })))
}

fn rand_suffix() -> u16 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut h);
    (h.finish() & 0xffff) as u16
}

pub async fn list_jobs(State(st): State<AppState>) -> Json<Vec<Job>> {
    let mut v: Vec<Job> = st.jobs.map.read().await.values().cloned().collect();
    v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    v.truncate(50);
    Json(v)
}

pub async fn cancel_job(
    State(st): State<AppState>,
    AxPath(id): AxPath<String>,
) -> Json<serde_json::Value> {
    let killed = if let Some(mut c) = st.jobs.procs.lock().await.remove(&id) {
        let _ = c.kill().await;
        true
    } else {
        false
    };
    st.jobs
        .set(&id, |j| {
            if j.status == "running" || j.status == "queued" {
                j.status = "cancelled".into();
                j.message = "cancelled".into();
                j.finished_at = now();
            }
        })
        .await;
    tracing::info!("export {id} cancelled (process killed: {killed})");
    Json(serde_json::json!({ "ok": true }))
}

pub async fn clear_jobs(State(st): State<AppState>) -> Json<serde_json::Value> {
    let mut m = st.jobs.map.write().await;
    m.retain(|_, j| j.status == "running" || j.status == "queued");
    Json(serde_json::json!({ "ok": true }))
}
