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

**Phase 0 complete.** Library browsing over SMB shares and local folders, byte-range
playback with native seeking, settings with credential storage, log viewer.

| Phase | State |
|---|---|
| 0 · scaffolding, library browser, range playback, SMB settings, logs | ✅ done |
| 1 · ffprobe cache, keyframe index, sprite scrubbing, integrity checks | next |
| 2 · segment model, canvas timeline, frame-accurate stepping, drag & drop | |
| 3 · export engine (keyframe-snap), remux incl. MPEG-TS → MP4 | |
| 4 · smart-cut (frame-exact) | algorithm validated in [`spike/`](spike/) |
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

Then open `http://<server>:8088`.

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
```

## Licence

MIT — see [LICENSE](LICENSE).
