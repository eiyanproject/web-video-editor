import { useEffect, useState } from 'react'
import Icon from './Icon'

/**
 * Jobs and log, in the space under the timeline.
 *
 * That space existed because the export strip is pinned to the bottom and the
 * controls belong under the picture, so the middle was always going to be
 * slack. Filling it with the two things you actually want while an export runs
 * - what is running, and what just went wrong - turns the gap into the reason
 * you stop switching to the Log page.
 *
 * It is deliberately passive: it shows, it does not act. The one exception is
 * cancelling a running job, because that is the thing you want within reach
 * exactly when you are watching this panel.
 */

type Job = {
  id: string
  source: string
  mode: string
  status: string
  progress: number
  message: string
  outputs: string[]
}

type LogRow = { ts: number; level: string; target: string; message: string }

/** Never the path. A job row is about the clip, and the folder it came from is
 *  noise at this width. */
const baseName = (p: string) => p.split(/[\\/]/).pop() || p

export default function Activity() {
  const [tab, setTab] = useState<'jobs' | 'log'>('jobs')
  const [jobs, setJobs] = useState<Job[]>([])
  const [log, setLog] = useState<LogRow[]>([])

  const active = jobs.find((j) => j.status === 'running' || j.status === 'queued')

  // Fast while something is running, lazy otherwise - the same cadence the rest
  // of the app polls at, so a busy box is not being asked twice a second by
  // three different panels.
  useEffect(() => {
    const poll = () => {
      fetch('/api/jobs').then((r) => r.json()).then(setJobs).catch(() => {})
      fetch('/api/logs?level=INFO').then((r) => r.json())
        .then((d) => setLog((d.entries ?? []).slice(-40))).catch(() => {})
    }
    poll()
    const id = setInterval(poll, active ? 1500 : 10000)
    return () => clearInterval(id)
  }, [!!active])

  const dot = (status: string) =>
    status === 'running' ? 'bg-indigo-400'
      : status === 'queued' ? 'bg-white/30'
      : status === 'done' ? 'bg-emerald-400'
      : status === 'failed' ? 'bg-red-400'
      : 'bg-white/20'

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-white/10">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1">
        {(['jobs', 'log'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded px-2 py-1 text-[11px] font-medium transition ${
              tab === t ? 'bg-white/[0.09] text-white/85' : 'text-white/40 hover:text-white/70'
            }`}>
            {t === 'jobs' ? 'Jobs' : 'Log'}
          </button>
        ))}
        {/* The running job earns a permanent readout here; everything else in
            this header is a tab. */}
        {active && (
          <span className="ml-1 flex min-w-0 items-center gap-1.5 text-[11px] text-white/45">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-indigo-400" />
            <span className="truncate">{active.message || active.status}</span>
          </span>
        )}
        <div className="flex-1" />
        {active && (
          <button
            onClick={() => fetch(`/api/jobs/${active.id}/cancel`, { method: 'POST' })}
            title="Cancel the running job"
            className="rounded p-1 text-white/40 transition hover:bg-white/10 hover:text-red-300">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-[11px]">
        {tab === 'jobs' ? (
          jobs.length === 0 ? (
            <div className="px-1 py-3 text-white/25">No exports yet.</div>
          ) : (
            jobs.slice(0, 30).map((j) => (
              <div key={j.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-white/[0.05]">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot(j.status)}`} />
                <span className="min-w-0 flex-1 truncate text-white/70">{baseName(j.source)}</span>
                <span className="shrink-0 text-white/30">{j.mode.replace('_', ' ')}</span>
                <span className="w-10 shrink-0 text-right tabular text-white/40">
                  {j.status === 'running' ? `${Math.round((j.progress ?? 0) * 100)}%` : j.status}
                </span>
              </div>
            ))
          )
        ) : (
          log.length === 0 ? (
            <div className="px-1 py-3 text-white/25">Nothing recorded yet.</div>
          ) : (
            [...log].reverse().map((l, i) => (
              <div key={i} className="flex gap-2 py-0.5">
                <span className="shrink-0 tabular text-white/20">
                  {new Date(l.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className={`min-w-0 flex-1 break-words ${
                  l.level === 'ERROR' ? 'text-red-300'
                    : l.level === 'WARN' ? 'text-amber-300'
                    : 'text-white/55'
                }`}>
                  {l.message}
                </span>
              </div>
            ))
          )
        )}
      </div>
    </div>
  )
}
