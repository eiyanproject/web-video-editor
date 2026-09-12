# Monitoring

This service satisfies the contract in
[eiyanproject/homelab-monitoring](https://github.com/eiyanproject/homelab-monitoring)
(`docs/SERVICE-CONTRACT.md`), so joining the stack is a target entry and nothing
else.

## The endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness. `{"status":"ok","version":"…"}`. No dependency checks, never authenticated. |
| `GET /readyz` | Readiness. 200 only when ffmpeg and ffprobe run, the analysis cache is writable, and every auto-mount share is actually mounted. 503 with a `problems` array otherwise. |
| `GET /metrics` | Prometheus text format. |

They sit at the root, **not** under `/api/`, for two reasons: that is where every
other service in the homelab puts them, and the nginx basic-auth block covers
`/api/` — a scrape must not need credentials to work.

`/api/health` is unchanged and still used by `install.sh`.

## Metrics

The four from the contract:

| Metric | Type | Labels |
| --- | --- | --- |
| `veditor_build_info` | gauge | `version`, `commit` |
| `veditor_requests_total` | counter | `route`, `method`, `status` |
| `veditor_request_duration_seconds` | histogram | `route` |
| `veditor_errors_total` | counter | `kind` |

Plus what is specific to this service, which is the part worth a dashboard:

| Metric | Type | Labels | Answers |
| --- | --- | --- | --- |
| `veditor_jobs` | gauge | `state` | Is anything exporting, and is anything stuck queued? |
| `veditor_analysis_in_flight` | gauge | — | Whole-file scans running right now |
| `veditor_concurrency_limit` | gauge | `kind` | What the caps are set to, next to what is running |
| `veditor_share_mounted` | gauge | `share` | The failure that makes everything else fail |
| `veditor_uptime_seconds` | gauge | — | Did it restart? |

**`route` is always the template Axum matched**, so `/api/jobs/abc123/cancel` is
recorded as `/api/jobs/:id/cancel`. Job ids and file paths never become labels —
one unbounded label takes the metric store down, and this API has two obvious
ways to produce one.

A useful first alert: `veditor_share_mounted == 0`, and
`veditor_jobs{state="queued"} > 0 and veditor_jobs{state="running"} == 0` for
more than a few minutes, which means the queue has stalled rather than drained.

## Registering it

On the mon LXC, add to `/srv/monitoring/targets/services.json`:

```json
[
  {
    "targets": ["192.168.0.20:80"],
    "labels": { "job": "service", "service": "web-video-editor", "kind": "lxc" }
  }
]
```

vmagent picks it up within 60 s; no restart. Port 80 is the nginx front door,
which proxies `/metrics` to the API — so this works whether or not the API port
is exposed, and it keeps working if the API port changes.

## Logs

One JSON object per line on **stdout**, with the contract's keys:

```json
{"ts":"2026-09-12T12:51:32Z","level":"info","msg":"export … cancelled","svc":"web-video-editor","target":"veditor_api::export"}
```

journald → rsyslog → VictoriaLogs carries it with no extra work, and
VictoriaLogs derives `level` from it directly.

### The one deliberate departure

The contract says stdout only, never a log file, on the grounds that there is
"nothing to rotate, nothing to run out of disk". This service **also** keeps a
local copy, at `config/logs/veditor.jsonl`.

Both of the contract's concerns are still met: the file is a bounded ring that
rotates at 4 MB and keeps exactly one previous generation, so the worst case on
disk is ~8 MB and known in advance. It exists because this box is edited from a
phone and a laptop, and "what went wrong ten minutes ago" should not require
shell access to the host at the moment something is already broken. It is
readable in **Settings → Log**, and reloaded into memory at startup so the view
spans restarts.

`VEDITOR_LOG_FILE` overrides the path; the file is disabled only by pointing it
somewhere unwritable, which is deliberate — this is meant to be on by default.
