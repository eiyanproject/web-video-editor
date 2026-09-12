//! Observability: the contract every service in the homelab satisfies.
//!
//! `docs/SERVICE-CONTRACT.md` in eiyanproject/homelab-monitoring defines it -
//! `/healthz`, `/readyz`, `/metrics`, and the four RED metrics. This module is
//! the whole implementation, hand-rolled rather than pulling in the prometheus
//! crate: four metrics and a handful of gauges is less code than the dependency
//! would add compile time, and the stack it feeds is itself built around
//! staying small.
//!
//! The one rule that matters here: **never label with a value**. A request id,
//! a file path or a job id as a label is a new stored time series every time,
//! and enough of those take the metric store down. Routes are labelled with the
//! template Axum matched, never the path that arrived.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};

use axum::{
    extract::{MatchedPath, State},
    http::Request,
    middleware::Next,
    response::Response,
};

use crate::AppState;

/// Seconds. Spans a header read (milliseconds) through a waveform build
/// (minutes), because both arrive on this API and a histogram that topped out
/// at ten seconds would report the interesting half as "+Inf".
const BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 300.0,
];

#[derive(Default)]
struct Hist {
    /// ALREADY cumulative: an observation bumps every bucket it falls inside,
    /// which is the `le` ("less than or equal") semantics Prometheus wants.
    /// Summing these again at render would double-count - the buckets then
    /// climb past the total and drop back to it at +Inf, and every quantile
    /// derived from them is nonsense.
    counts: Vec<u64>,
    sum: f64,
    count: u64,
}

impl Hist {
    fn observe(&mut self, v: f64) {
        if self.counts.is_empty() {
            self.counts = vec![0; BUCKETS.len()];
        }
        for (i, b) in BUCKETS.iter().enumerate() {
            if v <= *b {
                self.counts[i] += 1;
            }
        }
        self.sum += v;
        self.count += 1;
    }
}

#[derive(Default)]
struct Inner {
    /// (route, method, status) -> count
    requests: HashMap<(String, String, u16), u64>,
    /// route -> latency
    durations: HashMap<String, Hist>,
    /// kind -> count
    errors: HashMap<String, u64>,
}

#[derive(Clone)]
pub struct Metrics {
    inner: Arc<Mutex<Inner>>,
    started: Instant,
}

impl Default for Metrics {
    fn default() -> Self {
        Metrics {
            inner: Arc::new(Mutex::new(Inner::default())),
            started: Instant::now(),
        }
    }
}

impl Metrics {
    /// Counts something that went wrong, by CATEGORY - never by message. A
    /// category is a closed set you can put on a dashboard; a message is not.
    pub fn error(&self, kind: &str) {
        if let Ok(mut m) = self.inner.lock() {
            *m.errors.entry(kind.to_string()).or_insert(0) += 1;
        }
    }

    fn record(&self, route: &str, method: &str, status: u16, secs: f64) {
        if let Ok(mut m) = self.inner.lock() {
            *m.requests
                .entry((route.to_string(), method.to_string(), status))
                .or_insert(0) += 1;
            m.durations.entry(route.to_string()).or_default().observe(secs);
        }
    }
}

fn esc(v: &str) -> String {
    v.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ")
}

/// Renders the Prometheus text exposition format.
pub async fn render(st: &AppState) -> String {
    let mut out = String::with_capacity(4096);

    out.push_str("# HELP veditor_build_info Version and commit of the running binary.\n");
    out.push_str("# TYPE veditor_build_info gauge\n");
    out.push_str(&format!(
        "veditor_build_info{{version=\"{}\",commit=\"{}\"}} 1\n",
        esc(env!("CARGO_PKG_VERSION")),
        esc(option_env!("VEDITOR_COMMIT").unwrap_or("unknown")),
    ));

    if let Ok(m) = st.metrics.inner.lock() {
        out.push_str("# HELP veditor_requests_total HTTP requests by route template, method and status.\n");
        out.push_str("# TYPE veditor_requests_total counter\n");
        for ((route, method, status), n) in m.requests.iter() {
            out.push_str(&format!(
                "veditor_requests_total{{route=\"{}\",method=\"{}\",status=\"{}\"}} {}\n",
                esc(route),
                esc(method),
                status,
                n
            ));
        }

        out.push_str("# HELP veditor_request_duration_seconds Request latency by route template.\n");
        out.push_str("# TYPE veditor_request_duration_seconds histogram\n");
        for (route, h) in m.durations.iter() {
            for (i, b) in BUCKETS.iter().enumerate() {
                out.push_str(&format!(
                    "veditor_request_duration_seconds_bucket{{route=\"{}\",le=\"{}\"}} {}\n",
                    esc(route),
                    b,
                    h.counts.get(i).copied().unwrap_or(0)
                ));
            }
            out.push_str(&format!(
                "veditor_request_duration_seconds_bucket{{route=\"{}\",le=\"+Inf\"}} {}\n",
                esc(route),
                h.count
            ));
            out.push_str(&format!(
                "veditor_request_duration_seconds_sum{{route=\"{}\"}} {}\n",
                esc(route),
                h.sum
            ));
            out.push_str(&format!(
                "veditor_request_duration_seconds_count{{route=\"{}\"}} {}\n",
                esc(route),
                h.count
            ));
        }

        out.push_str("# HELP veditor_errors_total Failures by category.\n");
        out.push_str("# TYPE veditor_errors_total counter\n");
        for (kind, n) in m.errors.iter() {
            out.push_str(&format!(
                "veditor_errors_total{{kind=\"{}\"}} {}\n",
                esc(kind),
                n
            ));
        }
    }

    out.push_str("# HELP veditor_uptime_seconds Seconds since the process started.\n");
    out.push_str("# TYPE veditor_uptime_seconds gauge\n");
    out.push_str(&format!(
        "veditor_uptime_seconds {}\n",
        st.metrics.started.elapsed().as_secs()
    ));

    // What this service is actually for. These are the numbers that say whether
    // the box is busy, and they are exactly what the concurrency caps govern.
    let (running, queued, failed) = {
        let m = st.jobs.map.read().await;
        (
            m.values().filter(|j| j.status == "running").count(),
            m.values().filter(|j| j.status == "queued").count(),
            m.values().filter(|j| j.status == "failed").count(),
        )
    };
    out.push_str("# HELP veditor_jobs Export and remux jobs by state.\n");
    out.push_str("# TYPE veditor_jobs gauge\n");
    out.push_str(&format!("veditor_jobs{{state=\"running\"}} {running}\n"));
    out.push_str(&format!("veditor_jobs{{state=\"queued\"}} {queued}\n"));
    out.push_str(&format!("veditor_jobs{{state=\"failed\"}} {failed}\n"));

    out.push_str("# HELP veditor_analysis_in_flight Whole-file scans currently running.\n");
    out.push_str("# TYPE veditor_analysis_in_flight gauge\n");
    out.push_str(&format!(
        "veditor_analysis_in_flight {}\n",
        st.limits.in_flight()
    ));

    let (jobs_cap, scans_cap) = {
        let s = st.settings.read().await;
        (s.max_parallel_jobs.max(1), s.max_parallel_analysis.max(1))
    };
    out.push_str("# HELP veditor_concurrency_limit Configured ceiling, by kind of work.\n");
    out.push_str("# TYPE veditor_concurrency_limit gauge\n");
    out.push_str(&format!(
        "veditor_concurrency_limit{{kind=\"jobs\"}} {jobs_cap}\n"
    ));
    out.push_str(&format!(
        "veditor_concurrency_limit{{kind=\"analysis\"}} {scans_cap}\n"
    ));

    // A share that has dropped is the most common cause of everything else
    // failing, so it earns a series. The share NAME is a closed set the user
    // configured, so it is safe as a label.
    out.push_str("# HELP veditor_share_mounted 1 when the configured share is mounted.\n");
    out.push_str("# TYPE veditor_share_mounted gauge\n");
    let shares: Vec<(String, String)> = {
        let s = st.settings.read().await;
        s.smb
            .iter()
            .map(|c| (c.name.clone(), c.effective_mountpoint()))
            .collect()
    };
    for (name, mp) in shares {
        let up = if crate::is_mounted(&mp).await { 1 } else { 0 };
        out.push_str(&format!(
            "veditor_share_mounted{{share=\"{}\"}} {}\n",
            esc(&name),
            up
        ));
    }

    out
}

/// Times every request and records it under the route TEMPLATE.
pub async fn track(
    State(st): State<AppState>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // MatchedPath is the template Axum routed on, so `/api/jobs/abc/cancel` is
    // recorded against `/api/jobs/:id/cancel` and cannot explode the label set.
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "<unmatched>".to_string());
    let method = req.method().as_str().to_string();

    let t0 = Instant::now();
    let res = next.run(req).await;
    let status = res.status().as_u16();

    st.metrics
        .record(&route, &method, status, t0.elapsed().as_secs_f64());
    if status >= 500 {
        st.metrics.error("http_5xx");
    }
    res
}
