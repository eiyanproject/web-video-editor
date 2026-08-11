# Web Video Editor — Implementation Plan

A self-hosted, browser-based trim/join editor for a network media library. Movavi-style
UX, frame-accurate cuts, near-zero re-encoding. Deployed on Proxmox.

**Locked decisions (2026-08-11)**

| Decision | Choice |
|---|---|
| Cut accuracy | Smart-cut — frame accurate, re-encodes only boundary GOPs |
| Scope | Trim / delete / join only (no crop, watermark, subs, effects for now) |
| Hardware accel | Intel iGPU via QSV/VAAPI (`/dev/dri` passthrough) — **verified present** |
| Backend | Rust + Axum |
| Frontend | React 19 + Vite + Tailwind 4 |

---

## 1. What this is and is not

**Is:** cut a long video into segments, mark some segments for deletion, export the
survivors — either merged into one file or as separate files — with frame-exact cut
points and essentially no quality loss, in a fraction of real time.

**Is not:** an NLE. Every other tab in the Movavi screenshot (Audio, Adjustments,
Effects, Subtitles, Watermark, Crop) forces a **full re-encode of the entire video**.
There is no stream-copy path for a pixel filter. Those tabs will exist in the UI shell
as disabled placeholders so the layout is right, and can be added later behind an
explicit "this will re-encode the whole file" confirmation.

---

## 2. The core engine: smart-cut

This is the part that makes or breaks the project. Everything else is plumbing.

### 2.1 Why cuts are hard

H.264/HEVC video is stored in GOPs (groups of pictures) starting with a keyframe
(IDR). Every non-keyframe is expressed as a delta against its neighbours. You can only
stream-copy starting from a keyframe — if you cut mid-GOP and copy, the decoder has no
reference frames and you get corruption or a truncated segment.

Source GOP length is typically 2–10 seconds. So a pure `-c copy` cut lands wherever the
nearest keyframe is, potentially seconds from where you clicked.

### 2.2 The smart-cut algorithm

For a keep-segment `[A, B]` on a source with keyframe timestamps `K = [k₀, k₁, …]`:

```
kA_prev = greatest keyframe <= A
kA_next = smallest keyframe >  A
kB_prev = greatest keyframe <= B

head  = [A, kA_next)        -> RE-ENCODE   (skipped if A is exactly on a keyframe)
body  = [kA_next, kB_prev)  -> STREAM COPY (the 99%)
tail  = [kB_prev, B]        -> RE-ENCODE   (skipped if B is exactly on a keyframe)
```

Result per cut boundary: **1–10 seconds of video re-encoded**, everything else copied
byte-for-byte. Three keep-segments = at most 6 fragments = maybe 20 seconds of encoding
for a 2-hour film.

### 2.3 Encoder parameter matching

The concatenated pieces must agree or the output will not decode. Probe the source
once, then force the fragment encoder to match:

- codec, profile, level
- resolution, `pix_fmt` (e.g. `yuv420p`), SAR/DAR
- frame rate and field order
- colour: `colorspace`, `color_primaries`, `color_trc`, `color_range`

Fragment encode command shape:

```
ffmpeg -hwaccel qsv -ss <kA_prev> -i <src> -to <kA_next> \
  -c:v libx264 -crf 16 -preset medium \
  -profile:v <src_profile> -level <src_level> -pix_fmt <src_pixfmt> \
  -x264-params "keyint=<gop>:min-keyint=<gop>:scenecut=0:open-gop=0" \
  -colorspace <..> -color_primaries <..> -color_trc <..> \
  -an -f mpegts <tmp>/frag_head.ts
```

**Note on encoder choice:** use **libx264 for the boundary fragments, not QSV**, even
though the iGPU is available. Parameter fidelity (profile/level/pix_fmt/colour) is far
more predictable with x264, quality at CRF 16 is transparent, and the total encode
workload is a handful of seconds of video — CPU cost is irrelevant here. Reserve QSV
for **decode acceleration** (`-hwaccel qsv`) and for the optional future full-re-encode
path, where it actually pays off.

### 2.4 Audio handling

AAC frames are ~21–23 ms. Two options at each join:

- **Default: stream-copy audio throughout**, snapped to the nearest AAC frame. Max
  A/V error at a join is ~23 ms — inaudible and imperceptible. No encoder delay, no
  priming-sample drift, no generation loss.
- **Toggle: re-encode audio fragments** to match video exactly. Needed only if a
  specific source shows audible drift. Costs a re-encode of the same 1–10 s window and
  introduces AAC encoder delay that must be compensated with `-af aresample=async=1`.

Ship with copy as the default; expose the toggle in export settings.

### 2.5 Concatenation — two-tier strategy

**Tier 1 (fast path, one write):** the concat demuxer can reference byte ranges of the
original file directly via `inpoint`/`outpoint`, so the big copied middle sections are
*never materialized to disk*. Only the tiny encoded fragments become temp files.

```
file '/media/DPMI-060.mp4'
inpoint 12.400
outpoint 411.960
file '/tmp/frag_tail_0.ts'
file '/media/DPMI-060.mp4'
inpoint 582.000
outpoint 4273.120
...
```

```
ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart out.mp4.part
```

Total disk written = 1× output size. Total read = 1× kept duration.

**Tier 2 (fallback):** if Tier 1 errors on stream-parameter mismatch (differing SPS/PPS
between the source and the freshly-encoded fragments), remux every piece to MPEG-TS
with `h264_mp4toannexb` / `hevc_mp4toannexb`, concat the TS files, then remux to MP4.
TS carries SPS/PPS in-band per fragment, so it tolerates mismatches the MP4 route
rejects. Costs a second full pass and ~1× output size in temp space.

**Verification:** after every export, `ffprobe` the result — check duration is within
tolerance of the expected sum, frame count is sane, and no decode errors on a fast
`-v error -f null -` pass over the join points (±2 s windows only, not the whole file).
Report failures in the job log rather than silently shipping a broken file.

**Codec support matrix:**

| Source codec | Smart-cut | Notes |
|---|---|---|
| H.264 / AAC in MP4 | ✅ full | The primary target. Both tiers work. |
| HEVC / AAC in MP4 | ✅ full | `hevc_mp4toannexb` for Tier 2. |
| H.264 in MKV | ✅ full | Remux to MP4 on export. |
| AV1, VP9 | ⚠️ degraded | No TS route. Tier 1 only; fall back to keyframe-snap. |
| AC3 / DTS / E-AC3 audio | ✅ export, ❌ browser preview | Copies fine; needs a preview transcode to hear it in the browser. |

### 2.6 Export modes

Matching the screenshot's radio group:

- **As a single file** — all keep-segments concatenated in order into one output.
- **As separate files** — one output per keep-segment, named
  `{basename}_seg{n}{ext}` (template configurable).

### 2.7 Remuxing — changing container without touching the video

Rewrapping a stream into a different container is a **stream copy**, so it belongs
squarely in the no-re-encode scope. Same bytes, different box. Primary target here is
**MPEG-TS → MP4**.

Speed is purely I/O bound: a 4 GB TS becomes a 4 GB MP4 as fast as the disk or NIC can
move it, with zero quality change and no CPU to speak of.

**Two ways it shows up in the UI:**

- **Output container selector** on the export panel, so a trim job can also change
  container in the same pass — no second operation, no second write.
- **Standalone Convert action** for files needing no trimming at all. Select one or
  many, pick a target container, go. This is a batch queue item and needs no timeline
  interaction whatsoever.

**The gotchas that make naive `-c copy` produce broken files:**

| Problem | Why | Fix |
|---|---|---|
| AAC audio from TS | TS carries AAC in ADTS framing; MP4 needs `AudioSpecificConfig` | `-bsf:a aac_adtstoasc` — **mandatory**, and its absence is the single most common cause of silent-audio MP4s |
| Non-zero start PTS | Broadcast TS often starts at an arbitrary clock value, sometimes hours in | `-avoid_negative_ts make_zero -muxdelay 0 -muxpreload 0` |
| Missing/broken PTS | Damaged or spliced captures | `-fflags +genpts` |
| Timestamp wraparound | The 33-bit MPEG-TS PCR wraps roughly every 26.5 h | Detect discontinuity during probe and warn; wrapped files need `-copyts` handling |
| H.264 in Annex-B | TS uses start codes, MP4 needs length-prefixed AVCC | ffmpeg applies `h264_mp4toannexb` in reverse automatically |

**Container/codec legality — the part that decides copy vs re-encode:**

| Stream | into MP4 | Note |
|---|---|---|
| H.264, HEVC | ✅ copy | The common case |
| MPEG-2 video | ⚠️ legal but poorly supported | Offer copy, warn that some players refuse it |
| AAC | ✅ copy | With `aac_adtstoasc` |
| AC3 / E-AC3 | ⚠️ legal, patchy support | Copy by default, offer re-encode to AAC |
| **MP2 audio** | ❌ **not valid in MP4** | Very common in broadcast TS. Audio **must** be re-encoded to AAC — video still copies |

That last row matters: a TS from a broadcast capture frequently carries MP2 audio, and
there is no lossless path into MP4 for it. The right behaviour is to copy the video
untouched and re-encode only the audio — cheap, a few seconds — and to **say so in the
UI before starting** rather than silently producing a file with no sound.

Probe first, classify every stream as copy/convert/incompatible, and show that verdict
per file before the job runs. Never guess.

---

## 3. UI design

Two-pane layout, dark theme, matching the reference screenshot's density.

### 3.1 Right pane — library + player

- **Library browser** over the allowlisted roots (network JBOD mount, local dirs).
  Grid or list, folder tree, filter box, sort by name/date/size. Poster thumbnails
  pulled from the sprite cache (first sprite tile) so it isn't a wall of text.
- **Breadcrumbs relative to the library folder.** A path under a configured folder is
  shown as `Library / nas / Films`, not `Library / mnt / smb / nas / Films` — the
  mount plumbing is an implementation detail nobody chose. Every segment is clickable.
- **Sort and filter per folder** — by name, date or size, direction toggled by pressing
  the active key again; folders always sort first regardless. A filter box narrows the
  current folder, with a visible "filtered" marker so a short list is never mistaken
  for an empty one.
- **Honest counts.** A footer reports folders, files, total size, and *how many
  non-video files were hidden* — with a one-click "show all files" toggle. A filter
  that silently hides things makes "where did my file go" undiagnosable.
- **System folders are skipped**: `$RECYCLE.BIN`, `System Volume Information`,
  `#recycle` and `@eaDir` (Synology), `#snapshot`, `lost+found`, `.Trash*`. Every NAS
  carries these and they land at the top of the listing, exactly where a new user looks.
- **Last folder is remembered** across reloads, falling back to the library list if it
  has become unreachable — a share that is not mounted yet must not strand you.
- **Paste-a-path box.** Clicking down a folder tree is tedious when you already know
  where the file is. The box accepts an absolute container path, a root-relative one,
  or a Windows path straight from Explorer's "Copy as path" — the backend recognises
  the trailing segments and maps them onto a root. It widens what you may *type*,
  never what you may *reach*: every candidate still passes the §4.6 guard.
- **Integrity warnings.** Broken files are flagged in the listing rather than
  discovered when playback silently fails. Phase 0 catches the cheap cases (empty,
  truncated, unreadable) plus browser decode failures; Phase 1 adds real ffprobe
  checks — no video stream, unreadable moov, duration/index mismatch, decode errors
  in a sampled pass.
- **Player** — HTML5 `<video>` fed by byte-range requests, so seeking is native and
  instant. No transcoding for compatible sources.
- **Scrub timeline with hover thumbnails**, the K-Lite/MPC behaviour: hovering the
  timeline pops a thumbnail of that moment plus the timestamp. Backed by pre-generated
  sprite sheets (§4.2), so hover is instant and costs zero server work.

### 3.2 Left pane — editor

- **Tab bar** — Audio · Adjustments · Effects · Subtitles · Watermark · Crop · **Trim**.
  Only Trim is live; the others render disabled with a tooltip explaining they require
  a full re-encode. Keeps the visual layout honest for later expansion.
- **Live timecode readout** at `HH:MM:SS.mmm`, with **Copy time** and **Copy seconds**
  buttons. Millisecond precision because that is what a cut point needs, and copying is
  preferred over saving stills: anything written to the browser's download folder lands
  somewhere the app does not manage and the user did not choose (§3.5).
- **Preview surface** with the current frame, plus transport controls: jump-to-start,
  frame-back, play/pause, frame-forward, jump-to-end. Screenshot-to-PNG and mute
  buttons on the left, matching the reference.
- **Edit timeline** — this is the important custom component:
  - Zoomable (the "Scale" slider), pannable, canvas-rendered so a 2-hour file at high
    zoom stays at 60 fps.
  - Segment blocks: kept segments solid, deleted segments hatched/greyed (exactly the
    Segment 2 / Segment 4 treatment in the screenshot).
  - **Keyframe tick marks** along the ruler — the feature no consumer editor gives
    you. You can see where a cut would be free versus where it costs a re-encode.
  - Playhead with a live timecode readout down to milliseconds and frame number.
  - Drag segment boundaries to adjust; snap-to-keyframe with a modifier key held.
- **Segment list panel** — mirrors the screenshot: each row shows `Segment N` and its
  in/out timecodes, with a save-this-segment icon and a delete/undelete toggle. The
  delete toggle is reversible (crossed-out icon = currently excluded), never a
  destructive removal.
- **Per-cut cost badge** — each boundary shows either `lossless` (lands on a keyframe)
  or `exact · re-encodes 1.8s`, so you always know what the export will do.
- **Drag and drop from player to editor.** Dragging a file from the library, or the
  current clip from the player, onto the editor pane loads it for editing. Later this
  extends to dragging a *marked range* onto the segment list, which is the natural
  gesture for "keep this bit". The drag payload is a private MIME type carrying
  `{root, rel}` — never a filesystem path, so nothing leaks to other applications.
- **Export panel** — output container selector (§2.7), output directory picker (from the writable roots), merge/separate
  radio, filename template, and a Convert button. Reset and Save-and-Close as in the
  reference.

### 3.3 Control surface principle — every capability gets a button

**If the backend can do it, the UI must have a visible control for it.** No
API-only features, no capabilities reachable only by typing a path, editing JSON,
or knowing a keyboard shortcut. This applies to every phase and is not optional
polish — it is part of "done" for any feature.

Concretely, whenever a phase adds an endpoint or a capability, it also adds:

- a **button, toggle or menu item** in the pane where the user would look for it;
- a **visible state indicator** if the thing can be on/off, mounted/unmounted,
  running/failed — a dot, badge or label, never silence;
- a **result message** on success and on failure, in the UI, not just the log.

Keyboard shortcuts are an *accelerator for* a button, never a replacement. Drag
and drop is likewise an alternative path — anything draggable must also have a
click-to-do-the-same control, because drag targets are undiscoverable.

Recurring items that are easy to forget and must be present:

| Capability | Control |
|---|---|
| Re-read a directory | Refresh button (files move under you) |
| Any absolute path in play | Copy-path button |
| Any folder being browsed | "Add to library" button |
| Anything draggable | Equivalent click action |
| Mount / unmount, job running | Status dot + explicit action button |
| Destructive action | Confirm step, and an undo where feasible |
| Long-running work | Progress + a Cancel button |

Checklist at the end of each phase: list every endpoint added, and name the
control that reaches it. An endpoint with no control is an unfinished feature.

### 3.4 Empty states and quality-of-life guidance

An empty screen is a dead end. **Every empty or broken state must say what happened,
why, and give the button that fixes it.** "No items" is never an acceptable message on
its own.

The rule, applied everywhere:

> *state* → *plain-language explanation* → *the button that resolves it*

Required cases:

| State | What the user sees |
|---|---|
| No library folders configured | Prominent card: **Connect a network share (SMB)** and **Add a folder on this machine**, plus what they will need to hand (address, username, password) and the reassurance that shares mount read-only |
| Folders configured but unreachable | "Not mounted" banner with **Fix in Settings**, not a silent empty list |
| Folder has no videos | Say that only video files are listed, so an empty folder is not mistaken for a bug |
| No shares in Settings | Guided empty state with **+ Add your first share** and one sentence on why |
| Arriving at Settings *because* nothing is connected | Open a blank share form immediately with a numbered 5-step walkthrough — never drop the user on an empty page to work out |
| A share will not connect | Collapsible troubleshooting list covering the real failure modes: `CAP_SYS_ADMIN`, unprivileged LXC, SMB version for older NAS, missing domain/workgroup |
| Playback fails | Distinguish "corrupt/truncated" from "browser cannot decode this codec", and state that export is unaffected |
| Long job running | Progress plus **Cancel** |

The onboarding path must be walkable start to finish by someone who has just deployed
the container and has only a NAS address and a password. If any step requires reading
this document, that step is a bug.

Copy style: say what to do, not what went wrong internally. "The NAS may be asleep"
beats "ENOENT". Reassure about safety where it is genuinely true — sources are mounted
read-only, and that is worth saying out loud in the connect flow.

### 3.5 No storage by default

**Nothing is mounted, no library root exists, and no export destination is set until
the user configures one.** This is a security and safety position, not an inconvenience:

- A **default library root** implies read access that was never granted, and invites
  pasting paths into a scope nobody agreed to.
- A **default export destination** is worse — it is writable. Exports are large, and a
  writable folder the user never chose is exactly how a volume fills up unnoticed
  months later, on storage nobody was watching.

So the order is fixed: **connect storage first, then input and output become
available.** Compose declares no media or output bind mount. A fresh install starts
empty and asks (§3.4).

Export destinations are **validated before use**, because existence is not enough — a
read-only share looks like a perfectly good folder right up until the export fails on
its last step. `POST /api/check-path` reports exists / is-a-directory / writable /
on-a-mount, and the UI distinguishes four cases:

| Result | Meaning |
|---|---|
| writable **and** on a mount | Good — the normal case |
| writable, **not** on a mount | Warn: this is container-internal and is lost on rebuild |
| exists, not writable | Point at the read-only flag on the share |
| does not exist | Say so; do not silently create it |

Writability is tested by actually writing and deleting a probe file, not by inspecting
permission bits, because permission bits lie on network filesystems.

### 3.5b Nothing expensive happens by accident

`-skip_frame nokey` avoids *decoding* most frames. It does not avoid *reading*:
ffmpeg still demuxes the file end to end. Over a network share that means
**building thumbnails pulls the entire file across the link**, on the same NIC
that dominates export time.

Measured on a 25-minute 480p file over SMB: probe 0.2s, keyframe index 7.9s,
sprite build 11s. Scale that to a 2-hour 1080p film and the sprite build is a
4 GB read - minutes, not seconds.

So thumbnail generation is **never automatic**. Selecting a file must stay cheap.
`GET /api/sprites?peek=true` reports what is already cached and will not start a
build under any circumstance; only the explicit Thumbs button does.

Without thumbnails the scrubber is still the primary tool: full-height keyframe
ticks, minute markers, a large hover timecode, and the distance to the nearest
keyframe. That last figure is the one that matters for cutting, and it costs
nothing to display.

The keyframe index has the same property - it demuxes end to end - so it is
deferred to **Load into editor** rather than running on selection. The split is:

| Action | Cost | What runs |
|---|---|---|
| Select a file (preview) | headers only | `ffprobe` metadata |
| Load into editor | one full read | keyframe index |
| Thumbs button | one full read | sprite sheets |

Browsing a folder of fifty clips therefore costs fifty header reads, not fifty
multi-gigabyte transfers.

The general rule: **an action that reads an entire file needs a button.** Anything
that happens merely because the user clicked a filename must be metadata-cheap.

### 3.6 Connection state: report, never poll

Shares are attempted **once** — at startup for anything marked auto-mount, and whenever
the user explicitly asks. **There is no retry timer.**

Retrying a sleeping NAS on a schedule spins disks back up, keeps a WAN link busy, and
produces a log full of identical failures. Worse, it hides the problem: the share
eventually appears without anyone understanding why it was missing. So:

- One attempt, then record the outcome and stop.
- Offline shares show a **red dot, the word "offline", the actual mount error, and the
  time of the last attempt** — never a spinner or a silent empty library.
- The action button relabels itself **Mount → Reconnect** once an attempt has failed,
  and the panel states plainly that nothing is retrying in the background.
- **Reconnect all** re-attempts every auto-mount share in one press, reporting per-share
  results rather than failing on the first.

Three states must be visually distinct, because they mean different things:

| State | Meaning |
|---|---|
| not connected yet | never attempted — not a failure |
| connected | mounted and browsable |
| offline | attempted and failed, with the reason |

Config persistence is independent of connection state: `settings.json` lives on a host
bind mount, so shares, credentials and library folders survive rebuilds and updates
whether or not the NAS was reachable at the time.

### 3.7 Log page

A visible log, not just `docker logs`. Every mount attempt, save, path check and error
is captured into a capped in-memory ring buffer (2000 entries) by a `tracing` layer, so
nothing needs to be instrumented twice.

The page offers level filtering, a text filter, live tailing that can be paused, error
and warning counts, and copy / download / clear. It is the first place to look when a
share will not connect, and it means a user can hand over a log without shell access.

### 3.8 Frame accuracy in the browser

HTML5 `currentTime` seeking is not reliably frame-exact on its own. Solution:

- `video.requestVideoFrameCallback()` reports the `mediaTime` of the frame *actually
  presented*, which is ground truth for the playhead.
- Frame stepping = pause, `currentTime += 1/fps`, await the next rVFC, read back the
  true time. Never trust the value you wrote.
- Cut points are stored as **frame indices**, converted to timestamps at export using
  the exact source frame rate (handles 23.976/29.97 fractional rates without drift).

### 3.9 Keyboard

`Space` play/pause · `J`/`K`/`L` shuttle · `←`/`→` jump 5s · `,`/`.` frame step ·
`S` split at playhead · `Del` toggle segment deletion · `I`/`O` set in/out ·
`+`/`-` timeline zoom · `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo (the undo/redo arrows in the
reference screenshot).

---

## 4. Backend design

### 4.1 Services

```
nginx  ─┬─ /              -> static Vite bundle
        ├─ /api/*         -> editor-api (Axum)
        └─ /_media/*      -> internal; sendfile + byte ranges, X-Accel-Redirect only

editor-api (Rust/Axum)
        ├─ library browser (path-allowlisted)
        ├─ ffprobe cache (codec info, keyframe index)
        ├─ sprite/waveform generation queue
        ├─ export job queue + SSE progress
        └─ SQLite (sqlx) for job + cache state
```

**Media never flows through the Rust process.** The API authorizes a path and returns
an `X-Accel-Redirect` header; nginx streams the file with `sendfile` and full range
support. On a 4 GB box this matters — playback costs the app tier essentially nothing,
and range seeks are handled by battle-tested C code.

### 4.2 Sprite (hover thumbnail) generation

On first open of a file, enqueue a background job:

```
ffmpeg -hwaccel qsv -skip_frame nokey -i <src> \
  -vf "fps=1/5,scale=160:-2,tile=10x10" -an -vsync 0 \
  <cache>/<hash>/sprite_%03d.webp
```

`-skip_frame nokey` makes the decoder emit only keyframes, so a 2-hour 1080p file is
scanned in roughly 30–90 s with iGPU decode instead of many minutes. `fps=1/5` then
resamples onto a regular 5-second grid. A 2-hour film yields ~1440 tiles across 15
sprite sheets, about 3–8 MB total.

An `index.json` records interval, grid dims, tile size and count. The frontend
positions a `background-image` — hover preview is pure CSS, zero requests after load.
Sheets are served as they're written, so the timeline fills in progressively.

### 4.3 Keyframe index

```
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags \
  -of csv=p=0 <src>
```

Demux-only, no decoding — a couple of seconds even for a 2-hour file. Filter rows whose
flags contain `K`, store the timestamps as a compact array in the cache. This feeds the
timeline ticks, the snap behaviour and the smart-cut planner.

### 4.4 Browser compatibility handling

On open, classify the source:

- **H.264/AAC in MP4/MOV** → direct play. The common case, zero cost.
- **H.264/AAC in MKV** → background copy-remux to a cached MP4 (`-c copy`, I/O bound,
  ~1 min for 4 GB), then direct-play the cache. Seeking stays native.
- **HEVC, AC3/DTS, or anything else the browser refuses** → Phase 5: on-the-fly HLS
  preview transcode via QSV (roughly 5–10× real time on a modern iGPU). Until then,
  show an explicit banner: preview unavailable, editing by timecode still works, and
  **export is unaffected** — export never depends on the browser being able to decode.

### 4.5 API surface

```
GET  /api/roots                        configured library + output roots
GET  /api/browse?path=                 directory listing (allowlist-enforced)
GET  /api/media/:id/probe              codec, duration, fps, dimensions, streams
GET  /api/media/:id/keyframes          keyframe timestamp array
GET  /api/media/:id/sprites/index.json sprite metadata
GET  /api/media/:id/sprites/:n.webp    sprite sheet
GET  /api/media/:id/stream             -> X-Accel-Redirect to nginx
POST /api/projects                     save/load a segment edit
POST /api/jobs                         { source, segments[], mode, output_dir, naming }
GET  /api/jobs                         queue state
GET  /api/jobs/:id/events              SSE progress stream
POST /api/jobs/:id/cancel
GET/PUT /api/settings                  roots, output dir, concurrency, defaults
```

Job progress comes from `ffmpeg -progress pipe:1`, parsing `out_time_us` against the
planned total duration, pushed to the UI over SSE.

### 4.6 Safety rules

- Every path canonicalized and prefix-checked against the allowlist. No `..` escapes,
  no symlink traversal out of a root.
- **Source mounted read-only.** The editor can never damage the library.
- Writes go to `<target>.part` then atomically rename. No partial files with real names.
- Never overwrite an existing output without an explicit confirmation flag.
- Export concurrency default 1 (configurable) so the box stays responsive.

---

## 5. Server requirements

Your 4 GB / 4 core estimate is right, and honestly a little generous for trim/join.

**Memory ceiling in practice**

| Component | RAM |
|---|---|
| Axum API idle | 20–40 MB |
| nginx + static | ~20 MB |
| ffmpeg, copy/concat export | 100–200 MB |
| ffmpeg, boundary fragment encode (1080p x264) | 300–500 MB |
| ffmpeg, sprite generation | ~300 MB |
| **Peak: one export + one sprite job** | **~1.2–1.5 GB** |

4 GB is comfortable with plenty of headroom for page cache, which is what actually
makes the I/O fast. 2 GB would work; don't go below.

**CPU** — 4 cores is fine. Exports are I/O bound, not CPU bound: only seconds of video
get encoded. Cap ffmpeg `-threads` at 3 so the UI stays responsive during a job.

**Storage — the one you underestimated.** You're right that source and output live on
the network, but the container still needs local scratch:

| Purpose | Size |
|---|---|
| OS + runtime | ~3 GB |
| Sprite/probe cache | ~5–10 MB per film — budget 2 GB for a large library |
| MKV preview remux cache (if used) | up to 1× source per cached file — cap it, LRU-evict |
| Smart-cut temp, Tier 1 fast path | a few hundred MB (fragments only) |
| Smart-cut temp, Tier 2 fallback | **~1× output size** |

Allocate **32 GB** for the container disk. If you'd rather not, point the temp dir at
the network output directory instead — that also makes the final rename local to the
destination and avoids a second network round trip.

**The actual bottleneck is your network link.** A 2-hour 4 GB source, keeping 90
minutes: reading ~3 GB and writing ~3 GB over gigabit is ~60 s minimum, at line rate.
Total export ≈ 90 s, of which maybe 15 s is CPU. Conclusions:

- CPU and RAM are not your constraint. The NIC is.
- 2.5 GbE would roughly halve export wall time.
- Put the output directory on the same array as the source where practical.

**Confirmed host hardware (verified 2026-08-11)**

- GPU: Intel TigerLake-LP GT2 / Iris Xe Graphics, PCI `8086:9a49` at `00:02.0`
- Gen12 Xe-LP media engine: H.264 dec+enc, HEVC 8/10-bit dec+enc, VP9 dec+enc,
  AV1 **decode only** (no AV1 encode before Arc/Meteor Lake)
- `i915` bound and in use (`xe` also loaded but idle at 0 refs — no action needed)
- `/dev/dri/renderD128` present, device node `226:128`, owner `root:render`, mode 0660
- Not claimed by `vfio-pci` — no VM passthrough conflict

Implications: TGL-LP GT2 is a 4-core/8-thread mobile part, so the container's core
allocation is effectively the whole host. Allocate **3 cores, not 4**, so PVE and other
guests stay responsive during an export. Keep the ffmpeg `-threads 3` cap. A host of
this class is very likely on 1 GbE, which makes network transfer — not compute — the
dominant term in export wall time.

**Proxmox deployment — recommended shape**

Unprivileged LXC, Debian 13, running the two services natively under systemd. Docker
inside an unprivileged LXC adds a layer of friction that buys you nothing here, and the
`/dev/dri` passthrough is cleaner without it. A Compose file will be provided as an
alternative for a VM or privileged container.

```
cores: 4
memory: 4096
rootfs: 32G
mp0: /mnt/jbod,mp=/media,ro=1      # source library, read-only
mp1: /mnt/jbod/exports,mp=/output  # writable export target
dev0: /dev/dri/renderD128          # iGPU for QSV decode
```

The unprivileged container needs the `render` group GID mapped through for
`/dev/dri/renderD128` to be usable — that's a `lxc.idmap` entry plus a cgroup device
allow, documented in the setup guide alongside a verification command
(`vainfo` / `ffmpeg -hwaccels`).

---

## 6. Build phases

| Phase | Deliverable | Notes |
|---|---|---|
| **0** | Scaffolding — Axum service, Vite app, nginx config, settings, path allowlist, library browser, paste-a-path resolver, basic integrity warnings, direct play with byte ranges | End of this phase you can browse the JBOD and play files in the browser |
| **1** | ffprobe cache, keyframe index, sprite generation, hover-scrub timeline, **real integrity checking** (no video stream, bad moov, decode errors, TS timestamp discontinuities) | The right pane is fully done |
| **2** | Segment model, split/delete/undelete, zoomable canvas timeline with keyframe ticks, frame-accurate stepping, undo/redo, **drag and drop player → editor** | The left pane is usable, nothing exports yet |
| **3** | Export engine v1: keyframe-snap copy path, merge + separate modes, **remux / container conversion incl. MPEG-TS → MP4 (§2.7)**, job queue, SSE progress, output verification | **First genuinely useful build.** Fully lossless, cuts snap to keyframes |
| **4** | Smart-cut: boundary fragment encoder, parameter matching, Tier 1 concat, Tier 2 fallback, per-cut cost badges | Frame-exact cuts. The headline feature |
| **5** | Polish: MKV preview remux cache, HLS preview for incompatible codecs, audio waveform, batch queue, export presets, keyboard shortcuts, theming pass | |

Phase 3 is the point where this replaces Movavi for the actual job. Phase 4 is what
makes it better than the free alternatives.

---

## 7. Known risks

1. **Smart-cut join artifacts on unusual sources.** Variable frame rate, open-GOP
   encodes, or interlaced content can produce a visible hitch at a join. Mitigation:
   detect VFR and open-GOP during probe and warn; offer per-file fallback to
   keyframe-snap. The automated post-export verification pass catches the bad ones
   before you find them by watching.
2. **Browser codec coverage.** Preview is the fragile part, not export. Phase 4 keeps
   export working even when preview cannot decode a thing.
3. **Long sprite generation on first open of very long files.** Mitigated by
   progressive sheet delivery and by pre-warming the cache for recently added files.
4. **Network filesystem stalls.** SMB/NFS hiccups mid-export will fail an ffmpeg run.
   Jobs must be retryable, and `.part` files cleaned up on failure.
