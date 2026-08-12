# Web Video Editor

A self-hosted, browser-based video trimmer for a network media library. Cut a long
video into segments, drop the ones you don't want, and export the rest — merged or as
separate files — with **frame-exact cut points and almost no re-encoding**.

Built for a home server. Point it at an SMB share, edit in the browser, write the
result back to the share.

---

## Why this exists

Video is stored in GOPs, so you can only stream-copy from a keyframe — typically every
2–10 seconds. A plain `ffmpeg -c copy` cut therefore lands wherever the nearest keyframe
happens to be, not where you asked.

This project does **smart-cut**: it re-encodes only the partial GOP at each cut
boundary — a second or two of video — and stream-copies everything in between. Three
segments from a two-hour film means roughly six short fragments to encode and the rest
copied byte-for-byte. You get exact cuts at close to copy speed.

The timeline also draws **keyframe tick marks**, and each cut point is labelled either
`lossless` or `exact · re-encodes 1.8s`, so you always know what the export will do.

## Status

**Phases 0-5 complete.** Browse an SMB share, cut a clip on a zoomable timeline with
keyframe ticks, drop what you don't want, and export - merged, separate, or joined the
safe way - with cuts landing exactly where you put them and only the second or two
around each one re-encoded. Cut lists are saved back to the share, so reopening a film
brings its cuts with it.

| Phase | State |
|---|---|
| 0 · scaffolding, library browser, range playback, SMB settings, logs | ✅ |
| 1 · ffprobe cache, keyframe index, sprite scrubbing, integrity checks | ✅ |
| 2 · segment model, canvas timeline, frame stepping, drag & drop | ✅ |
| 3 · export engine, container remux, saved cut lists | ✅ |
| 4 · smart-cut, frame-exact | ✅ |
| 5 · waveform, batch remux, folder pickers, keyboard flow | ✅ |

Remaining ideas: HLS preview for codecs browsers refuse (HEVC, AC3), export presets.
Neither affects MP4 work, which is the well-supported path throughout.

## What it does

- **Frame-exact cuts.** Only the partial GOP at each boundary is rebuilt - measured at
  7.3 s of a 119 s export, 6% - and everything else is copied byte for byte. Turn it off
  and cuts snap to keyframes instead, for a pure copy.
- **Every cut is priced before you commit**: `lossless` if it lands on a keyframe, or
  `exact · re-encodes 1.8s` if not.
- **Three export shapes**: one joined file, one file per segment, or "safe join" - which
  writes complete files and joins those, for when a single-pass join comes out wrong.
- **Container remux** (MP4 ↔ MKV ↔ TS ↔ MOV), including in bulk from the Batch tab.
- **Saved cut lists** on the share, one small file per clip, restored automatically.
- **Aspect ratio is preserved everywhere**, including non-square pixels and portrait
  phone footage - in both players, in thumbnails, and through a rebuilt fragment.
- **The whole flow works from the keyboard.** Press `?` in the app.

---|---|
| 0 · scaffolding, library browser, range playback, SMB settings, logs | ✅ done |
| 1 · ffprobe cache, keyframe index, sprite scrubbing, integrity checks | ✅ done |
| 2 · segment model, canvas timeline, frame-accurate stepping, drag & drop | ✅ done |
| 3 · export engine (keyframe-snap), remux incl. MPEG-TS → MP4, saved edits | ✅ done |
| 4 · smart-cut (frame-exact) | ✅ done |
| 5 · preview transcode, waveform, batch queue, presets | |

Phase 3 is the point where it replaces a desktop editor for the job. Phase 4 is what
makes it better than the free alternatives.

See [`PLAN.md`](PLAN.md) for the architecture, the smart-cut algorithm, server sizing
and the design principles, and [`SETUP-LXC.md`](SETUP-LXC.md) for Proxmox deployment.

---

## Install

Requires Docker with the Compose plugin. On a fresh Debian/Ubuntu box the script will
tell you if anything is missing.

```bash
curl -fsSL https://raw.githubusercontent.com/eiyanproject/web-video-editor/main/install.sh | bash
```

Or clone and run it directly:

```bash
git clone https://github.com/eiyanproject/web-video-editor.git && cd web-video-editor && ./install.sh
```

Then open **`http://<server>`** — it serves on port 80, so there is no port to remember.

### Ports, TLS and a login

| | |
|---|---|
| `--port 8088` | serve HTTP somewhere else, e.g. when a reverse proxy already owns 80 |
| `--https-port 8443` | move HTTPS off 443 |
| `--auth user:password` | basic auth in front of everything |
| `--no-auth` | remove it again |
| `--self-signed` | TLS on 443 with a throwaway certificate |

For real HTTPS, drop `fullchain.pem` and `privkey.pem` into `./certs` and re-run — port
443 is only listened on when a certificate exists. Behind a reverse proxy, the usual
arrangement is to leave TLS to the proxy and point it at port 80; `X-Forwarded-For`,
`X-Forwarded-Proto` and `Range` are all passed through correctly.

> **There is no login by default.** On a LAN that is fine. Anything reachable from
> outside it should have `--auth` set at minimum, because whoever reaches this app can
> browse your shares, stream any file, and write exports. A VPN or Tailscale is better
> still. `/api/health` stays open either way, so uptime checks work without credentials.

### Updating

**Re-run the same script.** It pulls the latest code, rebuilds, and restarts — your
settings, shares and stored credentials are untouched.

```bash
cd /opt/web-video-editor && ./install.sh
```

Useful flags:

| Flag | Effect |
|---|---|
| `--dir <path>` | Install somewhere other than `/opt/web-video-editor` |
| `--port <n>` | Serve on a different port (default 8088) |
| `--no-pull` | Rebuild from local source without fetching |
| `--uninstall` | Stop and remove containers, keeping `config/` |

## First run

It starts with **no storage at all** — no library folder, no export destination,
nothing mounted. That is deliberate: a default library root implies access nobody
granted, and a default *writable* export folder is how a volume quietly fills with
large files on storage nobody is watching.

The empty state walks you through connecting a share. You need the address
(`\\192.168.1.10\media`), a username and a password. Shares mount **read-only by
default**, so your originals cannot be modified.

## Settings

Configured in the UI and saved to `config/settings.json` on the host, so you enter it
once and it survives rebuilds and updates.

- **Network shares (SMB/Samba)** — address accepts `\\host\share`, `//host/share` or
  `smb://host/share`. **Test** checks credentials without committing; **Mount** connects
  and adds it as a library folder automatically.
- **Default credentials** — one account usually covers every share on a NAS, so enter it
  once; any share leaving its own fields blank inherits it.
- **Library folders** and **export destination**, both editable at runtime.

Passwords are write-only over the API: `GET /api/settings` reports `has_password` but
never the value, and submitting a blank password keeps the stored one. Each field has a
**forget** link for actually removing one. `settings.json` is written `0600` and holds
credentials in plain text, so `config/` is gitignored — keep it off shared storage.

**Connection is attempted once, never on a timer.** If the NAS is asleep, the share is
marked **offline** with the actual mount error and the time of the last attempt, then
left alone. Polling a sleeping NAS spins disks back up for nothing. Press **Reconnect**
when you know it is back.

> **Proxmox note:** an *unprivileged* LXC cannot mount CIFS internally — the kernel
> forbids it regardless of capabilities. Mount on the host (see `SETUP-LXC.md`) and add
> it as a plain library folder instead. The error message says so if you hit it.

## Export destinations are validated

**Check** actually writes and deletes a probe file, because permission bits lie on
network filesystems. It distinguishes four cases:

| Result | Meaning |
|---|---|
| writable, on a mount | good |
| writable, **not** on a mount | ⚠️ container-internal — lost on rebuild |
| exists, not writable | read-only share |
| does not exist | says so; never silently creates it |

## Requirements

| | |
|---|---|
| CPU | 2–4 cores. Exports are I/O bound; only seconds of video are re-encoded |
| RAM | 4 GB comfortable, 2 GB workable |
| Disk | 32 GB — sprite cache plus smart-cut scratch |
| GPU | Optional. An Intel iGPU (`/dev/dri`) speeds up thumbnail scanning and future preview transcoding; the trim/join path needs no GPU at all |
| Network | The real bottleneck. Reading and writing several GB over gigabit dominates export time |

## Development

```bash
docker compose -f docker-compose.dev.yml up
```

UI on 5273 with hot reload, API on 8180. Source is bind-mounted; no toolchain is
installed on the host.

Two environment quirks worth knowing on Windows hosts: Vite's module cache lives in the
`node_modules` volume and survives restarts, and bind mounts don't deliver inotify
events. If the UI looks stale after an edit:

```bash
docker exec wve-ui-dev sh -c 'rm -rf /app/node_modules/.vite' && docker compose -f docker-compose.dev.yml restart ui
```

## API

```
GET  /api/health
GET  /api/browse?path=&all=      directory listing
GET  /api/resolve?path=          resolve any pasted path shape
GET  /api/stream?path=           video, with Range support
GET  /api/settings               config; passwords never returned
PUT  /api/settings
POST /api/smb/mount|unmount|mount-all|test
POST /api/check-path             validate an export destination
GET  /api/logs                   in-memory ring buffer
POST /api/logs/clear

GET  /api/probe?path=&refresh=   codec/format facts + integrity verdict (cached)
GET  /api/keyframes?path=        keyframe timestamps + gap statistics (cached)
GET  /api/sprites?path=          thumbnail sheet index; starts a build if absent
GET  /api/sprites/sheet?path=&n= one sprite sheet
POST /api/deep-check             decode the first and last 20s for corruption
GET  /api/cache                  analysis cache size
POST /api/cache/clear
GET  /api/poster?path=           one representative frame, cached
GET  /api/waveform?path=         audio peak envelope; DELETE drops it

GET  /api/edit?path=             saved cut list for a clip
POST /api/edit                   save one (write-then-rename)
GET  /api/edits                  every saved cut list
POST /api/export                 start an export job
GET  /api/jobs                   job list with live progress
POST /api/jobs/:id/cancel
```

## Licence

MIT — see [LICENSE](LICENSE).
