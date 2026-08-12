# Web Video Editor — handover

**Status: V1, production ready.** Phases 0–5 are complete and measured against a real
NAS. This document is the context doc: what it is, how it is deployed, why the awkward
parts are the way they are, what is still rough, and what is planned next.

Repository: <https://github.com/eiyanproject/web-video-editor> (public, MIT)

---

## 1. What it does

Cut a long video into segments, drop the ones you don't want, and export the rest —
merged, separate, or joined the safe way — with **cuts landing exactly where you put
them** and only a second or two around each one re-encoded. Everything else is copied
byte for byte, so a 25-minute export finishes in seconds and loses no quality.

Built for a home server: point it at an SMB share, edit in the browser, write the result
back to the share.

| Capability | Notes |
|---|---|
| Library over SMB | shares configured and mounted from the UI, credentials stored server-side |
| Playback | byte-range served, native seeking, no transcode |
| Analysis | ffprobe cache, keyframe index, sprite thumbnails, audio waveform |
| Cutting | canvas timeline, frame stepping, typed timecode, undo/redo |
| Export | frame-exact or keyframe-snap; single / separate / safe join; container remux |
| Saved cut lists | one small JSON per clip, kept on the share |
| Batch remux | whole-file container conversion with poster thumbnails |
| Keyboard | the entire flow; press `?` in the app |

**Primary target is MP4 / H.264 / AAC**, which is the best-supported path throughout.
HEVC, MKV and AC3 all export fine; only in-browser *preview* is limited for them.

---

## 2. Deploying

```bash
curl -fsSL https://raw.githubusercontent.com/eiyanproject/web-video-editor/main/install.sh | bash
```

Serves on **port 80** so a bare IP works. Re-run the same script to update — it pulls,
rebuilds, restarts, and never touches settings, credentials or saved cut lists.

| Flag | Purpose |
|---|---|
| `--port 8088` | move HTTP, e.g. when a reverse proxy owns 80 |
| `--https-port 8443` | move HTTPS |
| `--auth user:password` | basic auth in front of everything |
| `--no-auth` | remove it |
| `--self-signed` | throwaway certificate on 443 |
| `--dir`, `--no-pull`, `--uninstall` | as they sound |

Real certificates go in `./certs` as `fullchain.pem` / `privkey.pem`; 443 is only
listened on when they exist. Behind a reverse proxy, terminate TLS at the proxy and
point it at port 80 — `X-Forwarded-For`, `X-Forwarded-Proto` and `Range` all pass
through, so streaming and seeking survive the hop.

### Verifying a deployment

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://SERVER/api/health          # 200, always open
curl -s -o /dev/null -w '%{http_code}\n' http://SERVER/api/settings        # 401 when auth is on
curl -s -o /dev/null -w '%{http_code}\n' -u user:pass http://SERVER/api/settings   # 200
```

The health endpoint is deliberately exempt from auth so uptime checks and the
installer's own verify step work without credentials.

> Testing this on a Windows workstation is unreliable — Docker Desktop's handling of
> port 80 and WSL routing gets in the way. Verify on the server it will actually run on.

### Proxmox

`SETUP-LXC.md` covers the container, iGPU passthrough and mounts. The one thing that
catches people: **an unprivileged LXC cannot mount CIFS internally**, regardless of
capabilities — the kernel forbids it. There, mount the share on the host and add it as a
plain library folder instead. The app says so if you hit it.

---

## 3. Where things live

```
api/          Rust + Axum
  main.rs     settings, SMB mounting, browse/resolve/stream, logs, path handling
  media.rs    probe, keyframe index, sprites, poster, waveform  (all cached)
  edit.rs     saved cut lists
  export.rs   the export engine, including smart-cut
ui/           React 19 + Vite + Tailwind
  App.tsx     shell, both players, keyboard, session persistence
  Timeline.tsx / SegmentList.tsx / segments.ts   the edit model and its views
  ExportPanel.tsx / Batch.tsx / Settings.tsx / Logs.tsx / FolderPicker.tsx
  entrypoint.sh   renders the nginx config at start: ports, TLS, auth
spike/        the experiments that settled the smart-cut design
```

### Data

| What | Where | Survives a rebuild? |
|---|---|---|
| Settings, SMB credentials | `./config/settings.json` (0600) | yes |
| Analysis cache | `./cache/<hash>/` | yes, and regenerable |
| Saved cut lists | wherever you point them, usually the share | yes |
| Exports | wherever you point them | yes |

Cache keys are `path + size + mtime`, so a changed file is re-analysed automatically and
an unchanged one never is.

---

## 4. Decisions worth knowing

These are the ones that will look wrong until you know why. Each came out of a
measurement, not a preference.

**Smart-cut joins through MPEG-TS, using the concat protocol.** Joining MP4 fragments
through the concat *demuxer* produces a file whose stored timestamps look perfect — zero
non-monotonic DTS — and which throws 370+ errors on a full decode. Only the all-TS route
decodes clean. And it must be the concat *protocol*, not the demuxer: the demuxer
positions each file by the previous one's reported duration, and a TS piece reports its
standard 1.4 s start offset as part of that, so every join opened a gap and a 119 s cut
came out 368 s long.

**Fragments are driven by `-frames:v`, not `-t`.** Duration rounding added one frame per
boundary.

**Audio in a rebuilt fragment is re-encoded, not copied.** The fragment's video is
regenerated from zero while copied audio keeps the source's timestamps, so the output's
video ran 119 s while its audio spanned the 360 s between the original cut points.
Copied pieces keep their audio untouched, so this is a couple of seconds per cut.

**Pixel aspect is set with `-aspect`, not `-vf setsar`.** The filter sets the frame
property but never reaches the encoder's VUI, so it silently did nothing. Files stored
854×480 with a 1280:1281 sample aspect came out subtly stretched.

**Nothing expensive happens by accident.** Selecting a file costs a header read.
Anything that reads the whole file — keyframe index, thumbnails, waveform — needs an
explicit action: the index waits for *Load into editor*, thumbnails for a button, the
waveform for a switch (and even then only after the selection settles for a couple of
seconds, so clicking down a folder starts nothing).

**No storage by default.** No library root, no export destination, nothing mounted until
configured. A default writable folder nobody chose is how a volume quietly fills.

**Shares are attempted once, never polled.** A sleeping NAS is reported offline with the
real error and left alone until you press Reconnect.

**Every capability has a visible control**, and every empty state says what happened and
offers the button that fixes it. See `PLAN.md` §3.3–3.6.

---

## 5. Known limitations

Nothing here breaks MP4 trimming; they are the honest edges.

- **No login by default.** On a LAN that is fine. Anything reachable from outside needs
  `--auth` at minimum; a VPN or Tailscale is better.
- **Frame-exact does not apply to preview**, only to what is exported — the browser
  player is approximate by nature.
- **Variable-frame-rate sources fall back to keyframe-snap.** Detected and reported.
- **AV1 and VP9 cannot be smart-cut** — no MPEG-TS route. They snap to keyframes.
- **Rebuilt audio bitrate is derived from the file's overall bitrate**, an estimate
  rather than the true audio rate, which ffprobe does not always expose per stream.
- **HEVC and AC3 may not preview in the browser.** Export is unaffected; the media panel
  says which is which.
- **Single-user assumptions.** No accounts, no per-user state, one job queue.
- **Not tested on very long files** beyond ~2.5 hours, or on 8-bit-plus-HDR sources.

---

## 6. Planned: phone-friendly workflow

The current UI assumes a mouse, a keyboard and a wide screen. On a phone it is usable
but wrong in specific, fixable ways.

### The problems

1. **Two panes side by side** collapse into unusable slivers.
2. **Hover-only affordances** do not exist on touch: the scrub thumbnails, the per-row
   action buttons that appear on hover, and every tooltip.
3. **The keyboard pops up constantly.** Focusing the timecode field summons the OS
   keyboard, which covers the video — and the field is designed to be driven by arrows
   and digits, not typed into freely.
4. **Hit targets are ~20 px.** Touch wants 44 px.
5. **Drag targets are 6 px wide** — the cut handles and the pane dividers.

### The shape of the fix

**Layout.** One column below ~768 px, with a bottom tab bar: *Library · Player ·
Editor · Export*. Each is a full screen rather than a pane. The timeline gets the full
width, which is more than it has today.

**No keyboard unless asked.** The timecode field becomes `readOnly` with
`inputMode="none"` on touch, and gets a purpose-built on-screen pad: a digit grid plus
±1 frame / ±1 s / ±10 s, and a "nearest keyframe" key. This is *better* than the
keyboard for the job — the OS keyboard has no frame step. A small "type it" toggle stays
for the rare case.

**Gestures.** Drag the playhead; pinch to zoom the timeline; long-press a segment for
keep/drop; swipe between tabs. Every gesture keeps a visible button equivalent, per the
existing control-surface rule.

**Touch-sized controls.** 44 px minimum on anything tappable; cut handles widen to a
~24 px grab area while staying 2 px visually; dividers hidden entirely in one-column
mode since there is nothing to divide.

**Replacements for hover.** Tap-and-hold on the scrub bar shows the thumbnail preview
where hover did; row actions move into a swipe-left reveal or an always-visible
overflow button.

**Practicalities.** Screen Wake Lock during an export so the phone does not sleep
mid-job; a PWA manifest so it installs to the home screen and runs without browser
chrome; `100dvh` rather than `100vh` so the mobile URL bar does not crop the layout.

Estimated as a phase of its own. No backend work — this is entirely UI, which is why it
is worth doing as one focused pass rather than piecemeal.

---

## 7. Planned: subtitles and TTS

A new tab beside *Trim* and *Batch remux*. Three related jobs, in increasing difficulty.

### 7a. Subtitle editing and muxing

A cue list beside the timeline: start, end, text. Cues drawn on the timeline like
segments, draggable, with the waveform underneath for timing — which is exactly what the
waveform was built for.

- **Import** SRT, VTT and ASS. **Export** the same.
- **Soft subtitles** are a *stream copy*: mux the track alongside untouched video. MKV
  takes SRT and ASS natively; MP4 takes `mov_text`. This belongs in the existing remux
  path and preserves the project's whole promise.
- **Burned-in subtitles are a full re-encode of the entire video.** There is no
  stream-copy path for drawing pixels. It can be offered, but must be labelled loudly as
  what it is — the opposite of everything else the app does.
- Cue timings shift with the edit: a cue inside a dropped segment disappears, and later
  cues move earlier. That bookkeeping is the real work here, not the file formats.

### 7b. Generating speech from subtitles (TTS)

Turn a subtitle track into an audio track — dubbing, or narration for a silent clip.

- **Engine: Piper** is the right fit. It is offline, CPU-only, fast enough on a small
  box, has decent voices, and ships as a single binary with downloadable models. Coqui
  or XTTS sound better and want a GPU and far more memory than this box has.
- **Pipeline:** each cue → a WAV via Piper → placed at the cue's start time → mixed into
  one track → muxed as an *additional* audio track, or replacing the original. Video is
  copied throughout; only audio is encoded.
- **The hard part is timing.** Synthesised speech rarely matches its cue's duration. The
  options are to pad with silence when short, and when long either let it overrun the
  cue, or compress with `atempo` — which is audible past about 1.2×. A per-cue indicator
  showing "1.4× to fit" lets the user rewrite the line instead, which is usually the
  better answer.
- Voice, rate and pitch per track; a preview button per cue so nobody renders twenty
  minutes to discover the voice is wrong.

### 7c. Importing outside audio

Attach an existing audio file — a dub, a commentary, a TTS file made elsewhere — as an
additional track.

- Straightforward mux, plus an **offset control** for alignment, and a check that sample
  rate and channel count are compatible with the target container.
- Same waveform view, so the imported track can be aligned against the original audio by
  eye rather than by guessing.

### Sequencing

7a first: it is self-contained, useful alone, and builds the cue model the other two
need. 7c next, being mostly muxing on top of that model. 7b last — it is the only part
needing a new dependency in the image, and the only one where output quality is a matter
of taste rather than correctness.

---

## 8. Working on this

```bash
docker compose -f docker-compose.dev.yml up      # UI on 5273, API on 8180
```

Source is bind-mounted; no toolchain on the host. Two environment quirks on Windows
hosts: Vite's module cache lives in the `node_modules` volume and survives restarts, and
bind mounts do not deliver inotify events. If the UI looks stale after an edit:

```bash
docker exec wve-ui-dev sh -c 'rm -rf /app/node_modules/.vite' && docker compose -f docker-compose.dev.yml restart ui
```

The dev and production stacks carry **explicit, different compose project names**.
Without that they derive the same name from the folder, and starting one adopts and
recreates the other's containers.

**A note on how this was built, because it matters for whatever comes next.** Every
non-obvious behaviour in section 4 was found by measuring output, not by reasoning about
it — and in several cases the measurement contradicted a plan that looked sound. The
concat-demuxer route produced perfect-looking timestamps and a broken file. `-vf setsar`
appeared to work and did nothing. A saved position restored itself as zero while every
code path ran without error. If you change the export engine, verify the *output*:
duration, frame count, a decode pass, and a PSNR check against the source frame. The
tooling for all four is in `spike/`.
