import { useEffect, useState } from 'react'
import FolderPicker from './FolderPicker'
import type { Segment } from './segments'

export type Job = {
  id: string
  source: string
  mode: string
  status: string
  progress: number
  message: string
  outputs: string[]
  total_seconds: number
  verified: boolean
  snapped: { requested_start: number; requested_end: number; actual_start: number; actual_end: number }[]
}

const CONTAINERS = [
  { v: '', label: 'same as source' },
  { v: 'mp4', label: 'MP4' },
  { v: 'mkv', label: 'MKV' },
  { v: 'ts', label: 'MPEG-TS' },
  { v: 'mov', label: 'MOV' },
]

const tc = (t: number) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}

export default function ExportPanel({
  source, segs, outputDir, onSetOutputDir, onToast,
}: {
  source: string
  segs: Segment[]
  outputDir: string
  onSetOutputDir: (d: string) => void
  onToast: (m: string) => void
}) {
  const [mode, setMode] = useState<'merge' | 'separate' | 'separate_merge'>('merge')
  const [showPicker, setShowPicker] = useState(false)
  const [container, setContainer] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showJobs, setShowJobs] = useState(false)

  const kept = segs.filter((s) => s.keep)
  const keptSecs = kept.reduce((n, s) => n + (s.end - s.start), 0)

  const active = jobs.find((j) => j.status === 'running' || j.status === 'queued')

  const refresh = async () => {
    try { setJobs(await (await fetch('/api/jobs')).json()) } catch { /* transient */ }
  }
  useEffect(() => { refresh() }, [])

  // Poll only while something is actually running.
  useEffect(() => {
    if (!active) return
    const id = setInterval(refresh, 1000)
    return () => clearInterval(id)
  }, [!!active])

  const start = async () => {
    setErr(null); setBusy(true)
    try {
      const r = await fetch('/api/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source,
          segments: kept.map((s) => ({ start: s.start, end: s.end })),
          mode, container, output_dir: outputDir, overwrite,
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      onToast('Export started')
      setShowJobs(true)
      await refresh()
    } catch (e: any) {
      setErr(String(e.message ?? e))
    } finally { setBusy(false) }
  }

  const cancel = async (id: string) => {
    await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' })
    await refresh()
  }

  const done = jobs.filter((j) => j.status !== 'running' && j.status !== 'queued')

  return (
    <div className="shrink-0 border-t border-white/10 bg-white/[0.02]">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11px]">
        <span className="font-medium text-white/60">Export</span>

        <div className="flex overflow-hidden rounded border border-white/15">
          {([
            ['merge', 'single file', 'One file, joined directly from the source in a single pass. Fastest.'],
            ['separate', 'separate files', 'One file per kept segment, nothing joined.'],
            ['separate_merge', 'safe join', 'Writes each segment as its own complete file, joins those into one, then removes the pieces - you get a single file. Slower and needs temporary space, but far more robust than joining in one pass: use this when a single-file export comes out wrong.'],
          ] as const).map(([m, label, tip]) => (
            <button key={m} onClick={() => setMode(m)} title={tip}
              className={`px-2 py-0.5 ${mode === m ? 'bg-indigo-500/70 text-white' : 'hover:bg-white/10'}`}>
              {label}
            </button>
          ))}
        </div>

        <select value={container} onChange={(e) => setContainer(e.target.value)}
          title="Container. Changing it is a remux - the video is never re-encoded."
          className="rounded bg-white/10 px-1.5 py-0.5 outline-none">
          {CONTAINERS.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
        </select>

        <button onClick={() => setShowPicker(true)} title="Browse for the output folder"
          className="shrink-0 rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">📂</button>
        <input
          value={outputDir}
          onChange={(e) => onSetOutputDir(e.target.value)}
          placeholder="output folder…"
          className="min-w-0 flex-1 rounded bg-white/10 px-2 py-0.5 font-mono outline-none placeholder:font-sans placeholder:text-white/25"
        />

        <label className="flex shrink-0 items-center gap-1 text-white/45" title="Replace a file of the same name">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          overwrite
        </label>

        <button
          onClick={start}
          disabled={busy || !!active || !kept.length || !outputDir.trim()}
          title={!outputDir.trim() ? 'Set an output folder first' : `Export ${kept.length} segment(s), ${tc(keptSecs)}`}
          className="shrink-0 rounded bg-indigo-500 px-3 py-1 font-medium text-white hover:bg-indigo-400 disabled:opacity-40"
        >
          {active ? 'Exporting…' : `Convert ${kept.length}× · ${tc(keptSecs)}`}
        </button>

        <button onClick={() => { setShowJobs(!showJobs); refresh() }}
          className="shrink-0 rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">
          jobs{done.length ? ` (${done.length})` : ''}
        </button>
      </div>

      {err && (
        <div className="border-t border-red-400/30 bg-red-500/15 px-3 py-1.5 text-[11px] text-red-100">{err}</div>
      )}

      {active && (
        <div className="flex items-center gap-2 border-t border-white/10 px-3 py-1.5 text-[11px]">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-white/10">
            <div className="h-full bg-indigo-400 transition-[width]"
              style={{ width: `${Math.round(active.progress * 100)}%` }} />
          </div>
          <span className="shrink-0 tabular-nums text-white/60">{Math.round(active.progress * 100)}%</span>
          <span className="shrink-0 truncate text-white/40">{active.message}</span>
          <button onClick={() => cancel(active.id)}
            className="shrink-0 rounded bg-red-500/25 px-2 py-0.5 text-red-100 hover:bg-red-500/40">stop</button>
        </div>
      )}

      {showJobs && !!done.length && (
        <div className="max-h-32 overflow-y-auto border-t border-white/10 px-3 py-1 text-[10px]">
          {done.slice(0, 12).map((j) => (
            <div key={j.id} className="flex items-center gap-2 py-0.5">
              <span className={
                j.status === 'done' ? 'text-emerald-300' :
                j.status === 'cancelled' ? 'text-white/40' : 'text-red-300'
              }>
                {j.status === 'done' ? (j.verified ? '✓' : '⚠') : j.status === 'cancelled' ? '–' : '✕'}
              </span>
              <span className="min-w-0 flex-1 truncate text-white/50">
                {j.outputs.length ? j.outputs.map((o) => o.split('/').pop()).join(', ') : j.source.split('/').pop()}
              </span>
              <span className="shrink-0 truncate text-white/30">{j.message}</span>
            </div>
          ))}
          <button onClick={async () => { await fetch('/api/jobs/clear', { method: 'POST' }); refresh() }}
            className="mt-1 rounded px-1 text-white/25 hover:bg-white/10 hover:text-white/60">clear finished</button>
        </div>
      )}

      {showPicker && (
        <FolderPicker
          title="Choose the export folder"
          initial={outputDir}
          onClose={() => setShowPicker(false)}
          onPick={(p) => { onSetOutputDir(p); setShowPicker(false) }}
        />
      )}

      {/* Where the cuts will actually land once snapped to keyframes. */}
      {!!active?.snapped?.length && (
        <div className="border-t border-white/10 px-3 py-1 text-[10px] text-white/35">
          snapped to keyframes: {active.snapped.map((s, i) =>
            `${tc(s.actual_start)}–${tc(s.actual_end)}`).join(' · ')}
        </div>
      )}
    </div>
  )
}
