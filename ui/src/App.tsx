import { useEffect, useMemo, useRef, useState } from 'react'
import Settings from './Settings'
import Logs from './Logs'
import Scrubber, { type SpriteIndex } from './Scrubber'
import MediaInfo, { type Probe } from './MediaInfo'

// Paths are absolute container paths throughout. No root/rel pairs: you can
// paste anything the container can see and it opens.
//
// PLAN.md 3.3: every capability gets a visible control. Nothing here is
// reachable only by dragging, typing a path, or knowing a shortcut.

type Entry = {
  name: string
  abs: string
  is_dir: boolean
  size: number
  mtime: number
  is_video: boolean
  problem?: string
}

type SortKey = 'name' | 'mtime' | 'size'

const fmtSize = (n: number) => {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}

const fmtDate = (ts: number) =>
  ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : ''

// HH:MM:SS.mmm — millisecond precision, which is what a cut point needs.
const fmtTimecode = (t: number) => {
  if (!isFinite(t) || t < 0) t = 0
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const ms = Math.round((t - Math.floor(t)) * 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`
}

function describeMediaError(v: HTMLVideoElement): string {
  const e = v.error
  if (!e) return 'Playback failed for an unknown reason.'
  switch (e.code) {
    case 1: return 'Loading was aborted.'
    case 2: return 'Network error while reading the file — the share may have dropped.'
    case 3: return 'DECODE ERROR: the file is corrupt or truncated. Playback stopped partway.'
    case 4: return 'This browser cannot play this file. Either the container/codec is unsupported (HEVC, MKV, AC3) or the file is damaged. Export is unaffected — Phase 1 will tell you which.'
    default: return e.message || 'Playback failed.'
  }
}

const Btn = ({
  children, title, onClick, disabled, tone = 'plain', active,
}: {
  children: React.ReactNode; title: string; onClick: () => void
  disabled?: boolean; tone?: 'plain' | 'accent'; active?: boolean
}) => (
  <button
    title={title}
    onClick={onClick}
    disabled={disabled}
    className={`shrink-0 rounded px-2 py-1 text-xs transition disabled:opacity-30 ${
      tone === 'accent' ? 'bg-indigo-500/80 hover:bg-indigo-500'
        : active ? 'bg-indigo-500/40 hover:bg-indigo-500/60'
        : 'bg-white/10 hover:bg-white/20'
    }`}
  >
    {children}
  </button>
)

const LAST_DIR = 'veditor.lastDir'

export default function App() {
  const [page, setPage] = useState<'edit' | 'settings' | 'logs'>('edit')
  const [wantShare, setWantShare] = useState(false)
  const [cwd, setCwd] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [hiddenCount, setHiddenCount] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [selected, setSelected] = useState<Entry | null>(null)
  const [loaded, setLoaded] = useState<Entry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [playError, setPlayError] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [muted, setMuted] = useState(false)
  const [curTime, setCurTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [roots, setRoots] = useState<{ name: string; path: string }[]>([])
  const videoRef = useRef<HTMLVideoElement>(null)

  // Phase 1 analysis for the selected file.
  const [probe, setProbe] = useState<Probe | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [keyframes, setKeyframes] = useState<number[]>([])
  const [avgGap, setAvgGap] = useState(0)
  const [sprites, setSprites] = useState<SpriteIndex | null>(null)
  const [deep, setDeep] = useState<{ ok: boolean; errors: string[]; took_ms: number } | null>(null)
  const [deepBusy, setDeepBusy] = useState(false)

  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000) }

  // Analysis runs when a file is selected, in stages so the UI fills in as each
  // piece lands: probe is instant, keyframes take seconds, sprites take longer.
  useEffect(() => {
    setProbe(null); setKeyframes([]); setAvgGap(0); setSprites(null); setDeep(null)
    if (!selected || selected.is_dir) return
    let cancelled = false
    const q = (u: string) => `${u}?path=${encodeURIComponent(selected.abs)}`

    ;(async () => {
      setAnalyzing(true)
      try {
        const p = await (await fetch(q('/api/probe'))).json()
        if (cancelled) return
        if (p.error) { setError(`Could not analyse this file: ${p.error}`); return }
        setProbe(p)

        const k = await (await fetch(q('/api/keyframes'))).json()
        if (cancelled || k.error) return
        setKeyframes(k.times ?? []); setAvgGap(k.avg_gap ?? 0)

        // Thumbnails are NOT generated automatically. `-skip_frame nokey` avoids
        // decoding most frames but still demuxes the whole file, so building
        // them pulls the entire file across the network - minutes for a 2-hour
        // 1080p film, on the same link exports need. Press the button when you
        // want them for a file you are actually going to edit.
        //
        // Existing sheets are picked up for free, though: this is cache-only.
        const s: SpriteIndex = await (await fetch(q('/api/sprites') + '&peek=true')).json()
        if (!cancelled && s && s.done && s.sheets > 0) setSprites(s)
      } catch { /* surfaced by the error banner if it matters */ }
      finally { if (!cancelled) setAnalyzing(false) }
    })()

    return () => { cancelled = true }
  }, [selected?.abs])

  const rebuildThumbs = async () => {
    if (!selected) return
    setSprites(null)
    say('Rebuilding thumbnails…')
    let s: SpriteIndex = await (await fetch(
      `/api/sprites?refresh=true&path=${encodeURIComponent(selected.abs)}`)).json()
    setSprites(s)
    while (s && !s.done) {
      await new Promise((r) => setTimeout(r, 2500))
      s = await (await fetch(`/api/sprites?path=${encodeURIComponent(selected.abs)}`)).json()
      setSprites(s)
    }
    say('Thumbnails rebuilt')
  }

  const runDeepCheck = async () => {
    if (!selected) return
    setDeepBusy(true)
    try {
      const r = await fetch('/api/deep-check', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: selected.abs }),
      })
      setDeep(await r.json())
    } finally { setDeepBusy(false) }
  }

  const openDir = async (p: string, all = showAll) => {
    setError(null); setLoading(true)
    try {
      const r = await fetch(`/api/browse?path=${encodeURIComponent(p)}${all ? '&all=true' : ''}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setEntries(d.entries); setCwd(d.path); setParent(d.parent)
      setHiddenCount(d.hidden_non_video ?? 0)
      setFilter('')
      if (d.path) localStorage.setItem(LAST_DIR, d.path)
    } catch (e: any) {
      setEntries([]); setError(String(e.message ?? e))
    } finally { setLoading(false) }
  }

  // Reopen wherever you were last time. Falls back to the roots list if that
  // folder has gone away, e.g. a share that is not mounted yet.
  const loadRoots = () =>
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => setRoots(d.roots ?? []))
      .catch(() => {})

  useEffect(() => { loadRoots() }, [])

  useEffect(() => {
    const last = localStorage.getItem(LAST_DIR)
    if (!last) { openDir(''); return }
    fetch(`/api/browse?path=${encodeURIComponent(last)}`)
      .then((r) => (r.ok ? openDir(last) : openDir('')))
      .catch(() => openDir(''))
  }, [])

  const goToPasted = async () => {
    const p = pasted.trim()
    if (!p) return
    setError(null)
    try {
      const r = await fetch(`/api/resolve?path=${encodeURIComponent(p)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      if (d.is_dir) { await openDir(d.abs); setSelected(null) }
      else {
        if (d.parent) await openDir(d.parent)
        setSelected({ name: d.name, abs: d.abs, is_dir: false, size: 0, mtime: 0, is_video: d.is_video })
        setPlayError(null)
      }
      setPasted('')
    } catch (e: any) {
      setError(`Could not open that path: ${e.message ?? e}`)
    }
  }

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); say(`${what} copied`) }
    catch { say('Clipboard blocked by the browser') }
  }

  const addCwdToLibrary = async () => {
    if (!cwd) return
    try {
      const s = await (await fetch('/api/settings')).json()
      if (s.roots.some((r: any) => r.path === cwd)) return say('Already in your library')
      const name = cwd.split('/').filter(Boolean).pop() || cwd
      const r = await fetch('/api/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roots: [...s.roots, { name, path: cwd, writable: false }] }),
      })
      if (!r.ok) throw new Error((await r.json()).error)
      say(`Added "${name}" to your library`)
    } catch (e: any) { setError(String(e.message ?? e)) }
  }

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = f ? entries.filter((e) => e.name.toLowerCase().includes(f)) : entries
    const dir = sortAsc ? 1 : -1
    return [...list].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1 // folders always first
      if (sortKey === 'name') return dir * a.name.localeCompare(b.name, undefined, { numeric: true })
      if (sortKey === 'size') return dir * (a.size - b.size)
      return dir * (a.mtime - b.mtime)
    })
  }, [entries, filter, sortKey, sortAsc])

  const folders = shown.filter((e) => e.is_dir).length
  const files = shown.length - folders
  const totalSize = shown.reduce((n, e) => n + e.size, 0)

  // Clickable path segments. Far better than a truncated string when you are
  // six levels into a share and want to jump back two.
  //
  // Paths below a library folder are shown relative to it, so you get
  // "Library / nas / Films" rather than "Library / mnt / smb / nas / Films".
  // The /mnt/smb plumbing is an implementation detail nobody chose.
  const crumbs = useMemo(() => {
    if (!cwd) return []
    const root = roots
      .filter((r) => cwd === r.path || cwd.startsWith(r.path.replace(/\/$/, '') + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0]

    if (!root) {
      const parts = cwd.split('/').filter(Boolean)
      return parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))
    }
    const base = root.path.replace(/\/$/, '')
    const rest = cwd.slice(base.length).split('/').filter(Boolean)
    return [
      { name: root.name, path: base },
      ...rest.map((name, i) => ({ name, path: base + '/' + rest.slice(0, i + 1).join('/') })),
    ]
  }, [cwd, roots])

  const atHome = cwd === ''
  const unavailable = entries.filter((e) => e.problem).length
  const nothingConnected = atHome && (entries.length === 0 || unavailable === entries.length)
  const goConnect = () => { setWantShare(true); setPage('settings') }

  const srcUrl = selected ? `/api/stream?path=${encodeURIComponent(selected.abs)}` : undefined

  if (page === 'logs') return <Logs onClose={() => setPage('edit')} />
  if (page === 'settings')
    return <Settings startWithShare={wantShare}
      onClose={() => { setWantShare(false); setPage('edit'); openDir('') }} />

  return (
    <div className="flex h-full w-full flex-col">
      {toast && (
        <div className="absolute left-1/2 top-3 z-50 -translate-x-1/2 rounded bg-emerald-500/90 px-3 py-1.5 text-xs text-white shadow">
          {toast}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* ---------------- left: editor ------------------------------- */}
        <div className="flex w-1/2 flex-col border-r border-white/10">
          <div className="flex items-center gap-1 border-b border-white/10 p-2 text-xs">
            {['Audio', 'Adjustments', 'Effects', 'Subtitles', 'Watermark', 'Crop'].map((t) => (
              <button key={t} disabled title="Requires a full re-encode - not in the trim/join scope"
                className="cursor-not-allowed rounded px-3 py-2 text-white/25">{t}</button>
            ))}
            <button className="rounded bg-indigo-500/80 px-3 py-2 font-medium">Trim</button>
            <div className="flex-1" />
            <Btn title="Show the application log: mounts, saves, errors" onClick={() => setPage('logs')}>📋 Log</Btn>
            <Btn title="Open settings, network shares and library folders" onClick={() => setPage('settings')}>⚙ Settings</Btn>
          </div>

          <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5">
            <Btn title="Load the selected video into the editor" tone="accent"
              disabled={!selected} onClick={() => { setLoaded(selected); say(`Loaded ${selected!.name}`) }}>
              ⇤ Load into editor
            </Btn>
            <Btn title="Clear the editor" disabled={!loaded} onClick={() => { setLoaded(null); say('Editor cleared') }}>
              ✕ Clear
            </Btn>
            <div className="flex-1" />
            <Btn title="Copy the loaded file's full path" disabled={!loaded} onClick={() => copy(loaded!.abs, 'Path')}>
              ⧉ Copy path
            </Btn>
          </div>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const raw = e.dataTransfer.getData('application/x-veditor-clip')
              if (raw) { const c = JSON.parse(raw); setLoaded(c); setSelected(c); say(`Loaded ${c.name}`) }
            }}
            className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-white/30"
          >
            {loaded ? (
              <>
                <div className="text-white/70">{loaded.name}</div>
                <div className="max-w-full truncate text-xs text-white/30">{loaded.abs}</div>
                <div className="mt-3 text-xs">Timeline and cutting tools arrive in Phase 2</div>
              </>
            ) : (
              <>
                <div>No clip loaded</div>
                <div className="text-xs text-white/20">Select one on the right and press “Load into editor”, or drag it here</div>
              </>
            )}
          </div>
        </div>

        {/* ---------------- right: library + player -------------------- */}
        <div className="flex w-1/2 flex-col">
          <div className="flex flex-wrap items-center gap-1 border-b border-white/10 p-2 text-xs">
            <Btn title="Show library folders" onClick={() => openDir('')}>⌂ Home</Btn>
            <Btn title="Go to the parent folder" disabled={!parent} onClick={() => openDir(parent!)}>↑ Up</Btn>
            <Btn title="Re-read this folder from disk" onClick={() => { openDir(cwd); say('Refreshed') }}>⟳ Refresh</Btn>
            <Btn title="Add this folder to your library permanently" disabled={!cwd} onClick={addCwdToLibrary}>★ Add to library</Btn>
            <Btn title="Copy this folder's path" disabled={!cwd} onClick={() => copy(cwd, 'Folder path')}>⧉ Copy</Btn>
          </div>

          {/* breadcrumbs */}
          <div className="flex flex-wrap items-center gap-0.5 border-b border-white/10 px-3 py-1.5 text-xs">
            <button onClick={() => openDir('')} className="rounded px-1 text-white/50 hover:bg-white/10 hover:text-white">
              Library
            </button>
            {crumbs.map((c) => (
              <span key={c.path} className="flex items-center gap-0.5">
                <span className="text-white/20">/</span>
                <button onClick={() => openDir(c.path)}
                  className="max-w-[14rem] truncate rounded px-1 text-white/60 hover:bg-white/10 hover:text-white">
                  {c.name}
                </button>
              </span>
            ))}
            {loading && <span className="ml-2 text-white/30">loading…</span>}
          </div>

          <div className="flex gap-2 border-b border-white/10 p-2">
            <input
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && goToPasted()}
              placeholder="Paste any path…  \\NAS\media\clip.mp4  or  /mnt/smb/nas"
              className="flex-1 rounded bg-white/10 px-2 py-1 text-sm outline-none placeholder:text-white/25"
            />
            <Btn title="Open the pasted path" tone="accent" onClick={goToPasted}>Go</Btn>
            <Btn title="Clear the box" disabled={!pasted} onClick={() => setPasted('')}>✕</Btn>
          </div>

          <div className="aspect-video w-full bg-black">
            {srcUrl ? (
              <video key={srcUrl} ref={videoRef} src={srcUrl} controls preload="metadata"
                muted={muted} className="h-full w-full"
                onLoadedMetadata={() => { setPlayError(null); setDuration(videoRef.current?.duration ?? 0) }}
                onTimeUpdate={() => setCurTime(videoRef.current?.currentTime ?? 0)}
                onSeeked={() => setCurTime(videoRef.current?.currentTime ?? 0)}
                onError={() => videoRef.current && setPlayError(describeMediaError(videoRef.current))} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-white/30">Select a video</div>
            )}
          </div>

          {/* Hover-scrub timeline with thumbnails and keyframe ticks. */}
          {selected && duration > 0 && (
            <Scrubber
              path={selected.abs}
              duration={duration}
              current={curTime}
              keyframes={keyframes}
              sprites={sprites}
              onSeek={(t) => { if (videoRef.current) { videoRef.current.currentTime = t; setCurTime(t) } }}
            />
          )}

          <div className="flex flex-wrap items-center gap-1 border-b border-white/10 px-2 py-1.5">
            {/* Live playhead readout to millisecond precision. This is the number
                Phase 2 will turn into cut points, so it is worth showing now. */}
            <span className="rounded bg-black/40 px-2 py-1 font-mono text-xs text-emerald-300">
              {fmtTimecode(curTime)}
            </span>
            {duration > 0 && <span className="font-mono text-xs text-white/25">/ {fmtTimecode(duration)}</span>}
            {analyzing && <span className="text-xs text-amber-300/70">analysing…</span>}
            <Btn title="Copy the current playback time as HH:MM:SS.mmm" disabled={!selected}
              onClick={() => copy(fmtTimecode(videoRef.current?.currentTime ?? 0), 'Timecode')}>
              ⏱ Copy time
            </Btn>
            <Btn title="Copy the current time in seconds, e.g. 743.520" disabled={!selected}
              onClick={() => copy((videoRef.current?.currentTime ?? 0).toFixed(3), 'Seconds')}>
              Copy seconds
            </Btn>
            <Btn title={muted ? 'Unmute' : 'Mute'} disabled={!selected} onClick={() => setMuted(!muted)}>
              {muted ? '🔇' : '🔊'}
            </Btn>
            <Btn title="Fullscreen" disabled={!selected} onClick={() => videoRef.current?.requestFullscreen()}>⛶</Btn>
            <Btn
              title="Generate hover thumbnails for this file. Reads the entire file once, so it is slow over a network share — do it for files you are actually editing."
              disabled={!selected} onClick={rebuildThumbs}>
              {sprites?.done ? '⟳ Thumbs' : '🖼 Thumbs'}
            </Btn>
            <div className="flex-1" />
            <Btn title="Copy the selected file's path" disabled={!selected} onClick={() => copy(selected!.abs, 'Path')}>⧉ Path</Btn>
          </div>

          {probe && (
            <MediaInfo
              probe={probe}
              keyframeCount={keyframes.length}
              avgGap={avgGap}
              onDeepCheck={runDeepCheck}
              deep={deep}
              busy={deepBusy}
            />
          )}

          {playError && (
            <div className="border-l-2 border-red-400 bg-red-500/20 px-3 py-2 text-xs text-red-100">
              <b>Cannot play {selected?.name}</b>
              <div className="mt-0.5">{playError}</div>
            </div>
          )}
          {selected?.problem && (
            <div className="border-l-2 border-amber-400 bg-amber-500/20 px-3 py-2 text-xs text-amber-100">
              <b>File problem:</b> {selected.problem}
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 bg-red-500/20 px-3 py-2 text-xs text-red-200">
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="shrink-0 rounded px-1 hover:bg-white/10">✕</button>
            </div>
          )}

          {/* sort / filter bar */}
          {!atHome && (
            <div className="flex flex-wrap items-center gap-1 border-b border-white/10 px-2 py-1.5 text-xs">
              <input value={filter} onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter this folder…"
                className="w-40 rounded bg-white/10 px-2 py-1 outline-none placeholder:text-white/25" />
              {filter && <Btn title="Clear the filter" onClick={() => setFilter('')}>✕</Btn>}
              <span className="ml-1 text-white/25">sort</span>
              {(['name', 'mtime', 'size'] as SortKey[]).map((k) => (
                <Btn key={k} title={`Sort by ${k === 'mtime' ? 'date' : k}`} active={sortKey === k}
                  onClick={() => (sortKey === k ? setSortAsc(!sortAsc) : (setSortKey(k), setSortAsc(k === 'name')))}>
                  {k === 'mtime' ? 'date' : k}{sortKey === k ? (sortAsc ? ' ↑' : ' ↓') : ''}
                </Btn>
              ))}
              <div className="flex-1" />
              <Btn title={showAll ? 'Show only video files' : 'Show every file, not just video'}
                active={showAll}
                onClick={() => { const v = !showAll; setShowAll(v); openDir(cwd, v) }}>
                {showAll ? 'all files' : 'video only'}
              </Btn>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto text-sm">
            {nothingConnected && !error && (
              <div className="m-3 rounded-lg border border-indigo-400/30 bg-indigo-500/10 p-5">
                <div className="mb-1 text-base font-medium text-white/90">
                  {entries.length === 0 ? 'No folders connected yet' : 'Your folders are not reachable'}
                </div>
                <p className="mb-4 text-xs leading-relaxed text-white/50">
                  {entries.length === 0
                    ? 'Point the editor at your videos. If they live on a NAS or another PC, connect it as a network share — you enter the address and password once and it is remembered.'
                    : 'The folders below are configured but not currently mounted. Reconnect the share, or check that the NAS is awake and reachable.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button onClick={goConnect}
                    className="rounded bg-indigo-500 px-3 py-2 text-xs font-medium hover:bg-indigo-400">
                    🖧 Connect a network share (SMB)
                  </button>
                  <button onClick={() => { setWantShare(false); setPage('settings') }}
                    className="rounded bg-white/10 px-3 py-2 text-xs hover:bg-white/20">
                    📁 Add a folder on this machine
                  </button>
                </div>
                <div className="mt-4 border-t border-white/10 pt-3 text-xs text-white/40">
                  <div className="mb-1 font-medium text-white/60">What you will need</div>
                  <ul className="list-inside list-disc space-y-0.5">
                    <li>The share address, e.g. <code className="text-white/70">\\192.168.1.10\media</code></li>
                    <li>The username and password for that share</li>
                    <li>Nothing else — the folder is mounted read-only by default, so your originals cannot be touched</li>
                  </ul>
                </div>
              </div>
            )}
            {!nothingConnected && unavailable > 0 && (
              <div className="mx-3 mt-3 flex items-center gap-2 rounded bg-amber-500/15 px-3 py-2 text-xs text-amber-100">
                <span className="flex-1">{unavailable} folder{unavailable > 1 ? 's are' : ' is'} not mounted.</span>
                <button onClick={() => setPage('settings')} className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">
                  Fix in Settings
                </button>
              </div>
            )}

            {shown.map((e) => (
              <div key={e.abs}
                className={`group flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 ${
                  selected?.abs === e.abs ? 'bg-indigo-500/20' : ''
                }`}>
                <button
                  onClick={() => (e.is_dir ? openDir(e.abs) : (setSelected(e), setPlayError(null)))}
                  draggable={!e.is_dir}
                  onDragStart={(ev) => ev.dataTransfer.setData('application/x-veditor-clip', JSON.stringify(e))}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="w-4 shrink-0 text-white/40">
                    {e.is_dir ? '📁' : e.problem ? '⚠️' : e.is_video ? '🎬' : '📄'}
                  </span>
                  <span className={`flex-1 truncate ${e.problem ? 'text-amber-300' : e.is_video || e.is_dir ? '' : 'text-white/40'}`}>
                    {e.name}
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs text-white/25">{fmtDate(e.mtime)}</span>
                  <span className="w-16 shrink-0 text-right text-xs text-white/30">{fmtSize(e.size)}</span>
                </button>
                <div className="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100">
                  {!e.is_dir && e.is_video && (
                    <Btn title="Load straight into the editor" onClick={() => { setSelected(e); setLoaded(e); say(`Loaded ${e.name}`) }}>⇤</Btn>
                  )}
                  <Btn title="Copy this path" onClick={() => copy(e.abs, 'Path')}>⧉</Btn>
                </div>
              </div>
            ))}

            {!shown.length && !error && !nothingConnected && !loading && (
              <div className="p-4 text-white/30">
                {filter ? (
                  <>Nothing matches “{filter}”.
                    <button onClick={() => setFilter('')} className="ml-2 underline hover:text-white/60">clear filter</button>
                  </>
                ) : (
                  <>This folder has no videos or sub-folders.
                    {hiddenCount > 0 && (
                      <div className="mt-1 text-xs text-white/20">
                        {hiddenCount} non-video file{hiddenCount > 1 ? 's are' : ' is'} hidden —
                        <button onClick={() => { setShowAll(true); openDir(cwd, true) }}
                          className="ml-1 underline hover:text-white/60">show all files</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* folder summary */}
          {!atHome && !!shown.length && (
            <div className="flex items-center gap-3 border-t border-white/10 px-3 py-1.5 text-xs text-white/35">
              <span>{folders} folder{folders === 1 ? '' : 's'}</span>
              <span>{files} file{files === 1 ? '' : 's'}</span>
              {totalSize > 0 && <span>{fmtSize(totalSize)}</span>}
              {!showAll && hiddenCount > 0 && (
                <span className="text-white/25">· {hiddenCount} non-video hidden</span>
              )}
              {filter && <span className="text-indigo-300">· filtered</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
