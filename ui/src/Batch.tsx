import { useEffect, useRef, useState } from 'react'
import FolderPicker from './FolderPicker'

// Batch container conversion. No player and no timeline: this is for whole
// files, so a thumbnail and a name is all the identification needed. Every
// conversion is a stream copy - the video is rewrapped, never re-encoded.

type Entry = {
  name: string; abs: string; is_dir: boolean; size: number; mtime: number
  is_video: boolean; problem?: string
}
type Job = {
  id: string; source: string; status: string; progress: number
  message: string; outputs: string[]
}

const CONTAINERS = [
  { v: 'mp4', label: 'MP4' },
  { v: 'mkv', label: 'MKV' },
  { v: 'ts', label: 'MPEG-TS' },
  { v: 'mov', label: 'MOV' },
]

const fmtSize = (n: number) => {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}

export default function Batch({ onClose }: { onClose: () => void }) {
  const [cwd, setCwd] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [container, setContainer] = useState('mp4')
  const [outputDir, setOutputDir] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showPicker, setShowPicker] = useState<null | 'source' | 'dest'>(null)
  const [loading, setLoading] = useState(false)

  const open = async (p: string) => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`/api/browse?path=${encodeURIComponent(p)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setEntries(d.entries ?? []); setCwd(d.path ?? ''); setParent(d.parent ?? null)
      localStorage.setItem('veditor.batchDir', d.path ?? '')
    } catch (e: any) { setErr(String(e.message ?? e)); setEntries([]) }
    finally { setLoading(false) }
  }

  // Shares the one export folder setting with the editor and Settings, and
  // writes changes back so the three never drift apart.
  const serverOutputDir = useRef<string | null>(null)
  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then((d) => {
      serverOutputDir.current = d.output_dir ?? ''
      setOutputDir(d.output_dir ?? '')
    }).catch(() => {})
    open(localStorage.getItem('veditor.batchDir') || '')
  }, [])

  useEffect(() => {
    if (serverOutputDir.current === null || outputDir === serverOutputDir.current) return
    const t = setTimeout(() => {
      fetch('/api/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ output_dir: outputDir }),
      })
        .then(() => { serverOutputDir.current = outputDir })
        .catch(() => {})
    }, 800)
    return () => clearTimeout(t)
  }, [outputDir])

  const refresh = async () => {
    try { setJobs(await (await fetch('/api/jobs')).json()) } catch { /* transient */ }
  }
  useEffect(() => { refresh() }, [])
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued')
  useEffect(() => {
    if (!active.length) return
    const id = setInterval(refresh, 1200)
    return () => clearInterval(id)
  }, [active.length])

  const videos = entries.filter((e) => e.is_video)
  const toggle = (abs: string) => {
    const n = new Set(picked)
    n.has(abs) ? n.delete(abs) : n.add(abs)
    setPicked(n)
  }

  const convert = async () => {
    setBusy(true); setErr(null)
    const chosen = videos.filter((v) => picked.has(v.abs))
    let started = 0
    try {
      for (const v of chosen) {
        // The whole file is one segment. Probing gives its duration, which the
        // export engine needs to know it is copying end to end.
        const p = await (await fetch(`/api/probe?path=${encodeURIComponent(v.abs)}`)).json()
        if (!p || p.error || !p.duration) continue
        const r = await fetch('/api/export', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: v.abs,
            segments: [{ start: 0, end: p.duration }],
            mode: 'merge',
            container,
            output_dir: outputDir,
            overwrite,
          }),
        })
        if (!r.ok) throw new Error((await r.json()).error)
        started++
      }
      await refresh()
      if (!started) setErr('Nothing was queued — could not read those files.')
    } catch (e: any) {
      setErr(String(e.message ?? e))
    } finally { setBusy(false) }
  }

  const jobFor = (abs: string) => jobs.find((j) => j.source === abs)

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-xs">
        <span className="text-sm font-medium text-white/80">Batch remux</span>
        <span className="text-white/35">rewrap containers · stream copy, never re-encoded</span>
        <div className="flex-1" />
        <button onClick={onClose} className="rounded bg-white/10 px-3 py-1 hover:bg-white/20">← Back</button>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-white/10 px-2 py-1.5 text-xs">
        <button onClick={() => open('')} className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">⌂</button>
        <button onClick={() => parent && open(parent)} disabled={!parent}
          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-30">↑</button>
        <button onClick={() => open(cwd)} className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">⟳</button>
        <button onClick={() => setShowPicker('source')} className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">
          📂 Browse…
        </button>
        <span className="ml-1 min-w-0 flex-1 truncate font-mono text-white/40">{cwd || 'Library folders'}</span>
        {loading && <span className="text-white/30">loading…</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!!entries.filter((e) => e.is_dir).length && (
          <div className="mb-2 flex flex-wrap gap-1">
            {entries.filter((e) => e.is_dir).map((d) => (
              <button key={d.abs} onClick={() => open(d.abs)}
                className="max-w-[16rem] truncate rounded bg-white/5 px-2 py-1 text-xs text-white/60 hover:bg-white/10">
                📁 {d.name}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {videos.map((v) => {
            const j = jobFor(v.abs)
            const on = picked.has(v.abs)
            return (
              <button key={v.abs} onClick={() => toggle(v.abs)}
                className={`overflow-hidden rounded border text-left transition ${
                  on ? 'border-indigo-400 bg-indigo-500/15' : 'border-white/10 hover:border-white/25'
                }`}>
                <div className="relative aspect-video w-full bg-black">
                  <img
                    src={`/api/poster?path=${encodeURIComponent(v.abs)}`}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
                  />
                  {on && (
                    <span className="absolute right-1 top-1 rounded bg-indigo-500 px-1.5 text-[10px] text-white">✓</span>
                  )}
                  {j && (
                    <span className={`absolute bottom-1 left-1 rounded px-1.5 text-[10px] ${
                      j.status === 'done' ? 'bg-emerald-500/80' :
                      j.status === 'failed' ? 'bg-red-500/80' : 'bg-black/70'
                    }`}>
                      {j.status === 'running' ? `${Math.round(j.progress * 100)}%` : j.status}
                    </span>
                  )}
                </div>
                <div className="px-2 py-1">
                  <div className="truncate text-[11px] text-white/80">{v.name}</div>
                  <div className="text-[10px] text-white/30">{fmtSize(v.size)}</div>
                </div>
              </button>
            )
          })}
        </div>

        {!videos.length && !loading && (
          <div className="p-6 text-center text-xs text-white/30">
            No video files in this folder. Pick another with Browse.
          </div>
        )}
      </div>

      {err && <div className="bg-red-500/20 px-3 py-1.5 text-xs text-red-200">{err}</div>}

      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-white/[0.02] px-3 py-2 text-xs">
        <button onClick={() => setPicked(new Set(videos.map((v) => v.abs)))}
          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">select all</button>
        <button onClick={() => setPicked(new Set())} disabled={!picked.size}
          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-30">clear</button>
        <span className="text-white/40">{picked.size} selected</span>

        <span className="ml-2 text-white/40">to</span>
        <select value={container} onChange={(e) => setContainer(e.target.value)}
          className="rounded bg-white/10 px-1.5 py-1 outline-none">
          {CONTAINERS.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
        </select>

        <button onClick={() => setShowPicker('dest')}
          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">📂</button>
        <input value={outputDir}
          onChange={(e) => setOutputDir(e.target.value.replace(/[\r\n\t]/g, '').replace(/^\s+/, ''))}
          placeholder="output folder…"
          className="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 font-mono outline-none placeholder:font-sans placeholder:text-white/25" />

        <label className="flex items-center gap-1 text-white/45">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          overwrite
        </label>

        <button onClick={convert} disabled={busy || !picked.size || !outputDir.trim()}
          className="rounded bg-indigo-500 px-3 py-1 font-medium text-white hover:bg-indigo-400 disabled:opacity-40">
          {busy ? 'Queueing…' : `Convert ${picked.size}`}
        </button>
        {!!active.length && <span className="text-amber-300/80">{active.length} running</span>}
      </div>

      {showPicker && (
        <FolderPicker
          title={showPicker === 'source' ? 'Choose a folder to browse' : 'Choose the output folder'}
          initial={showPicker === 'source' ? cwd : outputDir}
          onClose={() => setShowPicker(null)}
          onPick={(p) => {
            if (showPicker === 'source') open(p)
            else setOutputDir(p)
            setShowPicker(null)
          }}
        />
      )}
    </div>
  )
}
