# web-video-editor

Rust + Axum API, React 19 + Vite UI. Two front ends from one bundle: the desktop
editor and a separate touch editor on its own port. `HANDOVER.md` is the context
doc — read it before changing the export engine.

## Documentation is part of "done"

**A change is not finished until the documents it made wrong are fixed in the
same pass.** Not a follow-up, not a separate commit — the same pass. There are
three, with different jobs:

| | |
|---|---|
| `HANDOVER.md` | what exists and why. **Authoritative** — when any other document disagrees with it, the other one is the bug |
| `README.md` | the public pitch. Only when user-visible behaviour changes |
| the Obsidian vault | `C:\Users\USERR\Documents\AI Things\Web Video Editor\` — 33 flat notes, one per concern, carrying the reasoning in more depth than HANDOVER has room for **and a code reference** (see below) |

`PLAN.md` is a record of original intent and is **never** edited. When the code
contradicts it, that goes in the vault's `Plan versus reality` note.

### Orient from the vault's code reference, not from the repo

Eight vault notes describe the code itself — `Repo layout`, `API reference`,
`Data shapes`, `Backend code map`, `Export engine internals`, `Media analysis
internals`, `Frontend code map`, `Dev and test recipes` — so a session can work
**without re-reading the source or re-probing the dev environment**. Start there.
Each carries a `checked:` date and ends in a *Verify this note* block of commands;
run the one that covers what you are about to rely on, because **a reference that
names a function, route, field or default is wrong the moment that thing changes.**

So changing an endpoint, a struct, a setting, a constant, an ffmpeg argument or a
build step means updating the matching reference note in the same pass, and bumping
its `checked:` date once you have re-verified it.

### The vault drifts silently

Nothing in this repo references it, so nothing will remind you, and the notes
state mechanisms confidently enough that a stale one reads as true. Before
calling a change done, grep the vault for whatever you just made false:

```bash
grep -rin 'on the share' "/c/Users/USERR/Documents/AI Things/Web Video Editor"
```

Three failure modes, in the order they actually happen:

1. **Stale line counts.** `Architecture.md` and `UI structure.md` tabulate every
   source file with a line count. If you touched one, `wc -l` it and fix the
   figure — including the index's own total. Never write an approximation when
   an exact count is one command away.
2. **Stale claims in notes you did not think were related.** Moving saved cut
   lists into SQLite falsified a sentence in `UI structure.md`, four notes away
   from the change.
3. **Orphans.** The vault is flat, `Web Video Editor.md` is the index, and every
   note links back to it. A note the index does not link is invisible.

`Personal notes.md` is the user's own scratch space. Read it; never edit it
unless asked.

## Observability

Every HTTP service in this repo exposes:
  - `GET /healthz` — liveness, no dependency checks, unauthenticated
  - `GET /readyz`  — 200 only when dependencies are reachable
  - `GET /metrics` — Prometheus text format

Metrics: `veditor_build_info`, `veditor_requests_total{route,method,status}`,
`veditor_request_duration_seconds{route}`, `veditor_errors_total{kind}`.
**Label with route templates, never with IDs or full paths** — this API has job
ids and absolute file paths in its URLs, and either one as a label is an
unbounded time series.

Logs: single-line JSON to stdout with keys `ts`, `level`, `msg`, `svc`. A
bounded, rotating local copy is also kept for the in-app viewer — see
`docs/MONITORING.md` for why that departs from the shared contract.

Register in the monitoring repo's `targets/services.json`.

## Conventions

- Nothing that reads a whole file happens without an explicit user action, and
  everything that does is capped by `max_parallel_jobs` / `max_parallel_analysis`
  and enforced server-side, never in the UI.
- Keyboard shortcuts match `e.key` first and fall back to the physical `e.code`
  only when what was typed is not a shortcut character — see HANDOVER §4.
