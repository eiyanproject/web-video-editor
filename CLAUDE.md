# web-video-editor

Rust + Axum API, React 19 + Vite UI. Two front ends from one bundle: the desktop
editor and a separate touch editor on its own port. `HANDOVER.md` is the context
doc — read it before changing the export engine.

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
