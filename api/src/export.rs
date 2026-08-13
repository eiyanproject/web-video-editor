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
    /// Frame-exact cutting: re-encode the partial GOP at each boundary instead
    /// of snapping the cut onto a keyframe.
    #[serde(default)]
    pub exact: bool,
}

// ---------------------------------------------------------------- smart-cut

/// One piece of the output: either copied verbatim or rebuilt.
#[derive(Debug, Clone)]
enum Piece {
    /// Stream-copied straight from the source. The overwhelming majority.
    Copy { start: f64, end: f64 },
    /// Re-encoded because the boundary falls mid-GOP. Seconds at most.
    Encode { start: f64, end: f64 },
}

impl Piece {
    fn span(&self) -> f64 {
        match self {
            Piece::Copy { start, end } | Piece::Encode { start, end } => end - start,
        }
    }
}

/// Splits one kept segment into copy and re-encode pieces.
///
/// A cut can only be stream-copied from a keyframe, so the head of a segment
/// that starts mid-GOP has to be rebuilt up to the next keyframe; likewise the
/// tail from the last keyframe to the requested end. Everything between is
/// copied byte for byte, which is why this stays fast: a two-hour film with
/// three cuts rebuilds a handful of seconds.
fn plan_segment(a: f64, b: f64, kf: &[f64], eps: f64) -> Vec<Piece> {
    if kf.is_empty() {
        return vec![Piece::Encode { start: a, end: b }];
    }
    let k_after = |t: f64| kf.iter().copied().find(|&k| k > t + eps);
    let k_at_or_before = |t: f64| kf.iter().copied().rev().find(|&k| k <= t + eps);

    let starts_clean = k_at_or_before(a).map(|k| (a - k).abs() <= eps).unwrap_or(false);
    let a_next = k_after(a);
    let b_prev = k_at_or_before(b);

    // The whole segment lives inside one GOP: nothing can be copied.
    match (starts_clean, a_next, b_prev) {
        (false, Some(next), _) if next >= b - eps => return vec![Piece::Encode { start: a, end: b }],
        _ => {}
    }

    let mut out = Vec::new();
    let body_start = if starts_clean {
        a
    } else if let Some(next) = a_next {
        out.push(Piece::Encode { start: a, end: next });
        next
    } else {
        return vec![Piece::Encode { start: a, end: b }];
    };

    let body_end = match b_prev {
        Some(k) if k > body_start + eps => k,
        _ => b,
    };

    if body_end > body_start + eps {
        out.push(Piece::Copy { start: body_start, end: body_end });
    }
    if b > body_end + eps {
        out.push(Piece::Encode { start: body_end, end: b });
    }
    out
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
    /// Serialises claiming a run slot. Counting the running jobs and then
    /// marking yourself running has to be one indivisible step, or two jobs
    /// admitted in the same instant both see the same free slot and both take
    /// it.
    admission: Arc<Mutex<()>>,
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

    async fn running_count(&self) -> usize {
        self.map
            .read()
            .await
            .values()
            .filter(|j| j.status == "running")
            .count()
    }
}

/// Holds a queued job until the box has a free slot, and marks it running the
/// moment it claims one.
///
/// Jobs used to be spawned the instant they were posted - "queued" was a label
/// that nothing ever enforced. Batch remux posts one job per file, so picking
/// forty files started forty ffmpeg processes at once, each one streaming a
/// whole file over the same share. The cap is a setting rather than a constant
/// because the right number depends on the box, but the default is 1: this
/// work is I/O bound on a network share, so a second concurrent job does not
/// finish the pair any sooner.
///
/// Returns false if the job was cancelled or cleared while it waited, in which
/// case there is nothing to run.
async fn wait_for_slot(st: &AppState, id: &str) -> bool {
    loop {
        match st.jobs.map.read().await.get(id).map(|j| j.status.clone()) {
            Some(s) if s == "queued" => {}
            // Cancelled while waiting, or the entry is gone.
            _ => return false,
        }

        let limit = st.settings.read().await.max_parallel_jobs.max(1);

        let running = {
            let _admit = st.jobs.admission.lock().await;
            let running = st.jobs.running_count().await;
            if running < limit {
                st.jobs
                    .set(id, |j| {
                        j.status = "running".into();
                        j.message = "starting".into();
                    })
                    .await;
                return true;
            }
            running
        };

        st.jobs
            .set(id, |j| {
                j.message = format!("waiting — {running} job(s) already running");
            })
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
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

/// Annex-B bitstream filter needed to put a stream into MPEG-TS.
fn ts_bsf(codec: &str) -> Option<&'static str> {
    match codec {
        "h264" => Some("h264_mp4toannexb"),
        "hevc" => Some("hevc_mp4toannexb"),
        _ => None,
    }
}

/// Encoder for rebuilding a boundary fragment.
///
/// libx264/libx265 rather than QSV even where an iGPU exists: parameter
/// fidelity (profile, pixel format, colour) is far more predictable on CPU, the
/// workload is a few seconds of video, and a fragment that does not match its
/// neighbours is worse than one that took two seconds longer to make.
fn fragment_encoder(codec: &str) -> Option<&'static str> {
    match codec {
        "h264" => Some("libx264"),
        "hevc" => Some("libx265"),
        _ => None,
    }
}

/// Builds every piece as MPEG-TS, then concatenates.
///
/// The spike settled this: joining MP4 fragments through the concat demuxer
/// produces a file whose stored timestamps look fine but which throws hundreds
/// of errors on a full decode. MPEG-TS carries SPS/PPS in band for every
/// fragment, so it tolerates the parameter-set differences between a
/// freshly-encoded piece and the original stream. Same measurement, three
/// variants: only the all-TS route decodes clean.
async fn run_smart_cut(
    st: &AppState,
    jobs: &Jobs,
    id: &str,
    src: &Path,
    probe: &media::Probe,
    segs: &[(f64, f64)],
    kf: &[f64],
    tmp: &Path,
    target: &Path,
    ext: &str,
) -> Result<(f64, usize), String> {
    let _ = st;
    let eps = if probe.fps > 0.0 { 0.5 / probe.fps } else { 0.02 };
    let enc = fragment_encoder(&probe.video_codec)
        .ok_or_else(|| format!("{} cannot be frame-exact cut", probe.video_codec))?;
    let bsf = ts_bsf(&probe.video_codec)
        .ok_or_else(|| format!("{} has no MPEG-TS route", probe.video_codec))?;

    let mut pieces: Vec<Piece> = Vec::new();
    for (a, b) in segs {
        pieces.extend(plan_segment(*a, *b, kf, eps));
    }
    let total: f64 = pieces.iter().map(|p| p.span()).sum();
    let reencoded: f64 = pieces
        .iter()
        .filter(|p| matches!(p, Piece::Encode { .. }))
        .map(|p| p.span())
        .sum();

    tracing::info!(
        "smart-cut: {} piece(s), re-encoding {:.2}s of {:.1}s ({:.2}%)",
        pieces.len(), reencoded, total,
        if total > 0.0 { reencoded / total * 100.0 } else { 0.0 }
    );
    jobs.set(id, |j| {
        j.message = format!("frame-exact · rebuilding {reencoded:.1}s of {total:.0}s");
    })
    .await;

    tokio::fs::create_dir_all(tmp)
        .await
        .map_err(|e| format!("cannot create scratch space: {e}"))?;

    let mut parts: Vec<PathBuf> = Vec::new();
    let mut done = 0.0f64;

    for (i, piece) in pieces.iter().enumerate() {
        let part = tmp.join(format!("p{i:04}.ts"));
        let slice = if total > 0.0 { piece.span() / total * 0.85 } else { 0.0 };

        let args: Vec<String> = match piece {
            Piece::Copy { start, end } => vec![
                "-hide_banner".into(), "-nostdin".into(), "-y".into(),
                "-ss".into(), format!("{start:.4}"),
                "-i".into(), src.to_string_lossy().to_string(),
                "-t".into(), format!("{:.4}", end - start),
                "-c".into(), "copy".into(),
                "-bsf:v".into(), bsf.into(),
                // Without this the copied audio runs past the end of the video
                // in the same piece; concat then starts the next piece after
                // the longer stream, leaving a gap in the picture. Every piece
                // must end when its video ends.
                "-shortest".into(),
                "-avoid_negative_ts".into(), "make_zero".into(),
                "-f".into(), "mpegts".into(),
                "-progress".into(), "pipe:1".into(), "-nostats".into(),
                part.to_string_lossy().to_string(),
            ],
            Piece::Encode { start, end } => {
                // -ss before -i is frame accurate when transcoding: ffmpeg seeks
                // to the preceding keyframe then decodes and discards up to the
                // exact timestamp asked for.
                let mut v: Vec<String> = vec![
                    "-hide_banner".into(), "-nostdin".into(), "-y".into(),
                    "-ss".into(), format!("{start:.4}"),
                    "-i".into(), src.to_string_lossy().to_string(),
                    // Frame count, not duration: -t rounding was adding a frame
                    // at each boundary, and four boundaries is four frames of
                    // drift for no reason.
                    "-frames:v".into(),
                    format!("{}", ((end - start) * probe.fps).round().max(1.0) as i64),
                    "-c:v".into(), enc.into(),
                    "-pix_fmt".into(),
                    if probe.pix_fmt.is_empty() { "yuv420p".into() } else { probe.pix_fmt.clone() },
                ];
                if enc == "libx264" {
                    v.extend(["-crf".into(), "16".into(), "-preset".into(), "medium".into()]);
                    if !probe.profile.is_empty() {
                        v.extend(["-profile:v".into(), probe.profile.to_lowercase()]);
                    }
                    // Closed GOP with an IDR at the very first frame, so the
                    // piece can be spliced without borrowing references.
                    v.extend([
                        "-x264-params".into(),
                        "scenecut=0:open-gop=0:min-keyint=1".into(),
                    ]);
                } else {
                    v.extend(["-crf".into(), "18".into(), "-preset".into(), "fast".into()]);
                    v.extend(["-x265-params".into(), "scenecut=0:open-gop=0".into()]);
                }
                if probe.fps > 0.0 {
                    v.extend(["-r".into(), format!("{:.6}", probe.fps)]);
                }
                // Pixel aspect must be carried onto the rebuilt fragment.
                //
                // Plenty of real files have non-square pixels: 854x480 stored
                // with a 1280:1281 sample aspect to display as 16:9 is common,
                // and phone footage is often flagged rather than stored square.
                // A fragment encoded at the default 1:1 is a different shape
                // from the copied pieces either side of it, and the finished
                // file takes the aspect of whichever piece happens to come
                // first - so a cut starting mid-GOP came out subtly stretched.
                //
                // `-aspect` rather than `-vf setsar`: the filter sets the frame
                // property but does not reach the encoder's VUI, so the flag was
                // silently doing nothing. Measured, not assumed.
                if let Some((num, den)) = probe.sar.split_once(':') {
                    if let (Ok(n), Ok(d)) = (num.parse::<u64>(), den.parse::<u64>()) {
                        if n > 0 && d > 0 && n != d && probe.width > 0 && probe.height > 0 {
                            let dar_w = probe.width as u64 * n;
                            let dar_h = probe.height as u64 * d;
                            v.extend(["-aspect".into(), format!("{dar_w}/{dar_h}")]);
                        }
                    }
                }
                // Audio is re-encoded in rebuilt fragments, not copied.
                //
                // A fragment's video is regenerated and starts at zero, but
                // copied audio packets keep the source's presentation times. The
                // join then produced a file whose video ran 119s while its audio
                // spanned the 360s between the two original cut points. Encoding
                // the handful of seconds of audio in a fragment keeps the piece
                // internally consistent; copied pieces are untouched, so this is
                // still a couple of seconds of audio per cut, not a re-encode.
                if probe.audio.first().map(|a| a.codec == "aac").unwrap_or(false) {
                    // Match the source rather than assuming: a hardcoded rate
                    // either throws away quality on a good source or wastes
                    // bits on a modest one. Only these few seconds are affected.
                    let kbps = if probe.bit_rate > 0 {
                        ((probe.bit_rate as f64 * 0.12) / 1000.0).round().clamp(96.0, 320.0) as u32
                    } else {
                        192
                    };
                    v.extend([
                        "-c:a".into(), "aac".into(),
                        "-b:a".into(), format!("{kbps}k"),
                    ]);
                } else {
                    v.extend(["-c:a".into(), "copy".into()]);
                }
                v.extend([
                    "-shortest".into(),
                    "-avoid_negative_ts".into(), "make_zero".into(),
                    "-f".into(), "mpegts".into(),
                    "-progress".into(), "pipe:1".into(), "-nostats".into(),
                    part.to_string_lossy().to_string(),
                ]);
                v
            }
        };

        run_ffmpeg(jobs, id, args, done, slice, piece.span()).await?;
        done += slice;
        parts.push(part);
    }

    // Join with the concat PROTOCOL, not the demuxer.
    //
    // MPEG-TS is designed to be byte-concatenable: the protocol streams the
    // pieces together and +genpts rebuilds one continuous timeline. The demuxer
    // instead positions each file using the previous one's reported duration -
    // and a TS piece reports its standard 1.4s start offset as part of that, so
    // every join opened a gap and a 119s cut came out 368s long. Same pieces,
    // same flags, entirely different result.
    let part_out = target.with_extension(format!("{ext}.part"));
    let joined_input = format!(
        "concat:{}",
        parts
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("|")
    );
    let mut args: Vec<String> = vec![
        "-hide_banner".into(), "-nostdin".into(), "-y".into(),
        "-fflags".into(), "+genpts".into(),
        "-i".into(), joined_input,
        "-c".into(), "copy".into(),
        "-avoid_negative_ts".into(), "make_zero".into(),
        "-max_interleave_delta".into(), "0".into(),
        "-muxdelay".into(), "0".into(), "-muxpreload".into(), "0".into(),
    ];
    if matches!(ext, "mp4" | "m4v" | "mov") {
        args.push("-movflags".into());
        args.push("+faststart".into());
        // Coming out of TS, AAC needs its ADTS framing converted back.
        if probe.audio.first().map(|a| a.codec == "aac").unwrap_or(false) {
            args.push("-bsf:a".into());
            args.push("aac_adtstoasc".into());
        }
    }
    args.push("-f".into()); args.push(muxer_for(ext).into());
    args.push("-progress".into()); args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(part_out.to_string_lossy().to_string());

    let r = run_ffmpeg(jobs, id, args, 0.85, 0.15, total).await;
    let _ = tokio::fs::remove_dir_all(tmp).await;
    r?;

    tokio::fs::rename(&part_out, target)
        .await
        .map_err(|_| format!("cannot finalise {}", target.display()))?;

    Ok((total, pieces.iter().filter(|p| matches!(p, Piece::Encode { .. })).count()))
}

/// Concatenates finished output files into one.
///
/// Used by "safe join" in both cutting modes. Joining complete, independently
/// valid files is more forgiving than asking the muxer to stitch across
/// discontinuities in a single pass.
async fn join_finished_files(
    jobs: &Jobs,
    id: &str,
    outdir: &Path,
    stem: &str,
    ext: &str,
    parts: &[String],
    overwrite: bool,
    total: f64,
) -> Result<String, String> {
    let joined = outdir.join(format!("{stem}_joined.{ext}"));
    if joined.exists() && !overwrite {
        return Err(format!("{} already exists", joined.display()));
    }
    let list = outdir.join(format!(".{stem}.join.txt"));
    let body: String = parts
        .iter()
        .map(|o| format!("file '{}'\n", o.replace('\'', "'\\''")))
        .collect();
    tokio::fs::write(&list, body)
        .await
        .map_err(|e| format!("cannot write the join list: {e}"))?;

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
    if matches!(ext, "mp4" | "m4v" | "mov") {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }
    args.push("-f".into()); args.push(muxer_for(ext).into());
    args.push("-progress".into()); args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(part.to_string_lossy().to_string());

    let r = run_ffmpeg(jobs, id, args, 0.9, 0.1, total).await;
    let _ = tokio::fs::remove_file(&list).await;
    match r {
        Err(e) => { let _ = tokio::fs::remove_file(&part).await; Err(e) }
        Ok(()) => tokio::fs::rename(&part, &joined)
            .await
            .map(|_| joined.to_string_lossy().to_string())
            .map_err(|_| format!("cannot finalise {}", joined.display())),
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

    let kf = media::load_keyframes(&st, &req.source).await.unwrap_or_default();

    // Frame-exact needs a codec with an MPEG-TS route and a constant frame rate;
    // anything else falls back to snapping rather than producing a bad file.
    let exact_ok = req.exact
        && fragment_encoder(&probe.video_codec).is_some()
        && ts_bsf(&probe.video_codec).is_some()
        && !probe.vfr
        && !kf.is_empty();
    if req.exact && !exact_ok {
        tracing::warn!(
            "export {id}: frame-exact unavailable for {} (vfr={}), falling back to keyframe-snap",
            probe.video_codec, probe.vfr
        );
    }

    let mut segs = Vec::new();
    let mut notes = Vec::new();
    for s in &req.segments {
        // Exact mode keeps the boundaries the user asked for; snap mode moves
        // them to the nearest keyframe so everything can be copied.
        let (a, b) = if exact_ok {
            (s.start.max(0.0), s.end.min(probe.duration))
        } else {
            let a = nearest(s.start, &kf).max(0.0);
            let b = if (s.end - probe.duration).abs() < 0.05 { s.end } else { nearest(s.end, &kf) };
            (a, b)
        };
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

    let result: Result<(), String> = if exact_ok && req.mode == "merge" {
        let target = outdir.join(format!("{stem}_cut.{ext}"));
        if target.exists() && !req.overwrite {
            Err(format!("{} already exists", target.display()))
        } else {
            let tmp = outdir.join(format!(".{stem}.smartcut"));
            match run_smart_cut(&st, &jobs, &id, &src, &probe, &segs, &kf, &tmp, &target, &ext).await {
                Ok((_dur, frags)) => {
                    tracing::info!("export {id}: frame-exact, {frags} fragment(s) rebuilt");
                    outputs.push(target.to_string_lossy().to_string());
                    Ok(())
                }
                Err(e) => {
                    let _ = tokio::fs::remove_dir_all(&tmp).await;
                    Err(e)
                }
            }
        }
    } else if exact_ok {
        // Frame-exact, one file per segment. Each gets its own TS pipeline, so
        // separate output is no longer stuck with keyframe-snapped starts.
        let mut acc = Ok(());
        for (i, seg) in segs.iter().enumerate() {
            let target = outdir.join(format!("{stem}_seg{:02}.{ext}", i + 1));
            if target.exists() && !req.overwrite {
                acc = Err(format!("{} already exists", target.display()));
                break;
            }
            let tmp = outdir.join(format!(".{stem}.smartcut{i}"));
            let one = [*seg];
            match run_smart_cut(&st, &jobs, &id, &src, &probe, &one, &kf, &tmp, &target, &ext).await {
                Ok(_) => outputs.push(target.to_string_lossy().to_string()),
                Err(e) => {
                    let _ = tokio::fs::remove_dir_all(&tmp).await;
                    acc = Err(e);
                    break;
                }
            }
        }

        // Safe join keeps its meaning under frame-exact: build complete files,
        // then join those. Otherwise the two buttons would quietly do the same
        // thing whenever exact cutting was on.
        if acc.is_ok() && req.mode == "separate_merge" && outputs.len() > 1 {
            match join_finished_files(&jobs, &id, &outdir, &stem, &ext, &outputs, req.overwrite, total).await {
                Ok(joined) => {
                    for f in &outputs {
                        let _ = tokio::fs::remove_file(f).await;
                    }
                    outputs.clear();
                    outputs.push(joined);
                }
                Err(e) => acc = Err(e),
            }
        }
        acc
    } else if req.mode == "separate" || req.mode == "separate_merge" {
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
    tokio::spawn(async move {
        if !wait_for_slot(&st2, &id2).await {
            return;
        }
        // Run the export in its OWN task so a panic inside it cannot leave the
        // job marked running forever - which would hold a slot and wedge every
        // job queued behind it, with nothing in the UI to explain why.
        let st3 = st2.clone();
        let id3 = id2.clone();
        if tokio::spawn(async move { run_export(st3, id3, req).await })
            .await
            .is_err()
        {
            tracing::error!("export {id2} panicked; releasing its slot");
            st2.jobs
                .set(&id2, |j| {
                    j.status = "failed".into();
                    j.message = "the export task crashed".into();
                    j.finished_at = now();
                })
                .await;
        }
    });

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
