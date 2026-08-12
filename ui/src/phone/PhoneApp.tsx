import { useEffect, useRef, useState } from 'react'
import {
  type Entry, fmtSize, fmtDate, fmtTimecode, displayAspect,
} from '../lib/shared'
// The real probe shape, not a second copy of it - the API grows fields and a
// duplicate here would quietly go stale.
import type { Probe } from '../MediaInfo'
import { useSegments, splitAt, toggleKeep, mergeAt, snapToKeyframe, normalise, keptDuration } from '../segments'
import ScrubPad from './ScrubPad'
import TimeWheel from './TimeWheel'

/**
 * The phone front end.
 *
 * A SEPARATE APP on its own port, not a responsive mode of the desktop one.
 * That is deliberate: the desktop editor assumes a mouse, a keyboard and two
 * side-by-side panes, and every attempt to make one tree serve both ends up
 * with `isPhone &&` threaded through a 1800-line component. Here the layout is
 * a single column by construction and nothing needs a hover state, so neither
 * side has to defend itself against the other's assumptions. They share the
 * API, the edit model in ../segments, and the types and formatters in
 * ../lib/shared - which is the part that actually matters for consistency.
 */

const LAST_DIR = 'veditor.phone.lastDir'

type Job = {
  id: string; status: string; progress: number; message: string
  outputs: string[]
}

/** 44px minimum, because that is the smallest thing a thumb hits reliably. */
const Tap = ({
  children, onClick, disabled, tone = 'plain', className = '',
}: {
  children: React.ReactNode; onClick: () => void
  disabled?: boolean; tone?: 'plain' | 'accent' | 'danger'; className?: string
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`min-h-[44px] shrink-0 rounded-lg px-4 text-sm font-medium transition active:scale-[0.97] disabled:opacity-30 ${
      tone === 'accent' ? 'bg-indigo-500 text-white'
        : tone === 'danger' ? 'bg-white/10 text-amber-200'
        : 'bg-white/10 text-white/85'
    } ${className}`}
  >
    {children}
  </button>
)

export default function PhoneApp() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [cwd, setCwd] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selected, setSelected] = useState<Entry | null>(null)
  const [loaded, setLoaded] = useState<Entry | null>(null)
  const [probe, setProbe] = useState<Probe | null>(null)
  const [loadedProbe, setLoadedProbe] = useState<Probe | null>(null)
  const [keyframes, setKeyframes] = useState<number[]>([])

  const [sheet, setSheet] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const editVideoRef = useRef<HTMLVideoElement>(null)
  const [curTime, setCurTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [editTime, setEditTime] = useState(0)
  const [editDuration, setEditDuration] = useState(0)

  // ---- export
  const [outputDir, setOutputDir] = useState('')
  const [mode, setMode] = useState<'merge' | 'separate' | 'separate_merge'>('merge')
  const [jobs, setJobs] = useState<Job[]>([])
  const [exporting, setExporting] = useState(false)

  const fps = loadedProbe?.fps || 25
  const { segs, setSegs, apply, undo, redo, canUndo, canRedo } = useSegments(editDuration, loaded?.abs ?? '')
  const [selectedSeg, setSelectedSeg] = useState<number | null>(null)
  const editLoadedFor = useRef<string | null>(null)

  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500) }

  const openDir = async (p: string) => {
    setError(null); setLoading(true)
    try {
      const r = await fetch(`/api/browse?path=${encodeURIComponent(p)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setEntries(d.entries); setCwd(d.path); setParent(d.parent)
      if (d.path) localStorage.setItem(LAST_DIR, d.path)
    } catch (e: any) {
      setEntries([]); setError(String(e.message ?? e))
    } finally { setLoading(false) }
  }

  // Reopen wherever this phone was last time, falling back to the library roots
  // if that folder has gone away - a share that is not mounted yet, usually.
  useEffect(() => {
    const last = localStorage.getItem(LAST_DIR)
    if (!last) { openDir(''); setSheet(true); return }
    fetch(`/api/browse?path=${encodeURIComponent(last)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setEntries(d.entries); setCwd(d.path); setParent(d.parent) })
      .catch(() => openDir(''))
  }, [])

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json())
      .then((d) => setOutputDir(d.output_dir ?? '')).catch(() => {})
  }, [])

  // Selecting costs a header read, nothing more - the same promise the desktop
  // app makes. Nothing here ever reads a whole file without being asked.
  useEffect(() => {
    setProbe(null)
    if (!selected || selected.is_dir) return
    let cancelled = false
    fetch(`/api/probe?path=${encodeURIComponent(selected.abs)}`)
      .then((r) => r.json())
      .then((p) => { if (!cancelled && !(p as any).error) setProbe(p) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selected?.abs])

  // Loading into the editor is the explicit action that earns the keyframe
  // index - it reads the whole file, so it waits to be asked.
  useEffect(() => {
    setLoadedProbe(null); setKeyframes([]); editLoadedFor.current = null
    if (!loaded) return
    let cancelled = false
    const q = (p: string) => `${p}?path=${encodeURIComponent(loaded.abs)}`
    ;(async () => {
      try {
        const p = await (await fetch(q('/api/probe'))).json()
        if (cancelled || p.error) return
        setLoadedProbe(p)
        const k = await (await fetch(q('/api/keyframes'))).json()
        if (!cancelled && !k.error) setKeyframes(k.times ?? [])
      } catch { /* the scrub bar simply has no ticks */ }
    })()
    return () => { cancelled = true }
  }, [loaded?.abs])

  // Saved cut lists live on the share, so the phone picks up what the desktop
  // left and vice versa. Same endpoint, same shape.
  useEffect(() => {
    if (!loaded?.abs || !editDuration) return
    const key = loaded.abs
    let cancelled = false
    ;(async () => {
      try {
        const d = await (await fetch(`/api/edit?path=${encodeURIComponent(key)}`)).json()
        if (cancelled || !d?.segments?.length) { editLoadedFor.current = key; return }
        setSegs(normalise(d.segments, editDuration))
        editLoadedFor.current = key
        say(`Loaded saved cuts (${d.segments.length} segments)`)
      } catch { editLoadedFor.current = key }
    })()
    return () => { cancelled = true }
  }, [loaded?.abs, editDuration])

  // Autosave, debounced. Skipped until the saved edit for this clip has been
  // read back, or the freshly-reset single segment would overwrite it.
  useEffect(() => {
    if (!loaded?.abs || editLoadedFor.current !== loaded.abs || segs.length < 1) return
    const t = setTimeout(() => {
      fetch('/api/edit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: loaded.abs, duration: editDuration, fps,
          segments: segs.map((s) => ({ start: s.start, end: s.end, keep: s.keep })),
        }),
      }).catch(() => {})
    }, 1500)
    return () => clearTimeout(t)
  }, [segs, loaded?.abs])

  const activeJob = jobs.find((j) => j.status === 'running' || j.status === 'queued')

  // Polled even when this phone started nothing, because the job queue is
  // shared: an export launched from the desktop has to lock this editor too, or
  // the safety net only catches the case that was never the problem. Fast while
  // something runs, lazy otherwise.
  useEffect(() => {
    const poll = () => fetch('/api/jobs').then((r) => r.json()).then(setJobs).catch(() => {})
    poll()
    const id = setInterval(poll, activeJob ? 1000 : 8000)
    return () => clearInterval(id)
  }, [!!activeJob])

  // One ffmpeg job already owns the box. Editing itself is local and costs the
  // server nothing, but everything that would QUEUE more work is held back:
  // another export, and loading a clip - which reads the whole file to build a
  // keyframe index, over the same share the export is streaming through.
  const exportBusy = !!activeJob

  const seekEdit = (t: number) => {
    const clamped = Math.max(0, Math.min(editDuration || t, t))
    if (editVideoRef.current) editVideoRef.current.currentTime = clamped
    setEditTime(clamped)
  }

  const cutHere = () => {
    if (!editDuration) return
    const next = splitAt(segs, editTime)
    if (next === segs) { say('Already a cut here'); return }
    apply(() => next)
    say(`Cut at ${fmtTimecode(editTime).slice(0, 8)}`)
  }

  // The desktop removes a cut from the segment list, a row at a time. There is
  // no room for that here, so this takes the cut NEAREST the playhead - which
  // is the one you are looking at when you decide it was wrong.
  const uncutHere = () => {
    if (segs.length < 2) { say('No cuts to remove'); return }
    let best = 0
    for (let i = 0; i < segs.length - 1; i++) {
      if (Math.abs(segs[i].end - editTime) < Math.abs(segs[best].end - editTime)) best = i
    }
    const at = segs[best].end
    apply((cur) => mergeAt(cur, best))
    say(`Removed the cut at ${fmtTimecode(at).slice(0, 8)}`)
  }

  const openInEditor = (e: Entry) => {
    if (exportBusy) { say('Export running — wait before loading another clip'); return }
    setLoaded(e); setSelected(e); setSheet(false)
    say(`Editor: ${e.name}`)
  }

  const startExport = async () => {
    const kept = segs.filter((s) => s.keep)
    if (!kept.length) { say('Every segment is dropped'); return }
    if (!outputDir.trim()) { say('Set an export folder in the desktop Settings'); return }
    setExporting(true)
    try {
      const r = await fetch('/api/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: loaded!.abs,
          segments: kept.map((s) => ({ start: s.start, end: s.end })),
          mode, container: '', output_dir: outputDir, overwrite: false, exact: true,
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      say('Export started')
      setJobs(await (await fetch('/api/jobs')).json())
    } catch (e: any) {
      say(String(e.message ?? e))
    } finally { setExporting(false) }
  }

  const srcFor = (e: Entry) => `/api/stream?path=${encodeURIComponent(e.abs)}`
  const aspect = displayAspect(probe) ?? 16 / 9
  const kept = segs.filter((s) => s.keep)

  const dirs = entries.filter((e) => e.is_dir)
  const files = entries.filter((e) => !e.is_dir)

  return (
    // 100dvh, not 100vh: the mobile URL bar is part of the viewport in vh and
    // crops the bottom of the layout as it hides and shows.
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-[#0b0d12] text-white">

      <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="text-sm font-semibold">Video Editor</span>
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/40">phone</span>
        <div className="flex-1" />
        <Tap onClick={() => setSheet(true)} tone="accent">📁 Files</Tap>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">

        {/* ---- player ------------------------------------------------------ */}
        <section>
          <div className="w-full bg-black" style={{ aspectRatio: String(aspect) }}>
            {selected ? (
              <video
                key={selected.abs}
                ref={videoRef}
                src={srcFor(selected)}
                controls
                playsInline
                preload="metadata"
                className="h-full w-full"
                onLoadedMetadata={() => setDuration(videoRef.current?.duration ?? 0)}
                onTimeUpdate={() => setCurTime(videoRef.current?.currentTime ?? 0)}
                onSeeked={() => setCurTime(videoRef.current?.currentTime ?? 0)}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="text-sm text-white/45">Nothing playing</div>
                <Tap onClick={() => setSheet(true)} tone="accent">📁 Browse files</Tap>
              </div>
            )}
          </div>

          {selected && (
            <>
              <ScrubPad
                current={curTime}
                duration={duration}
                onSeek={(t) => {
                  if (videoRef.current) videoRef.current.currentTime = t
                  setCurTime(t)
                }}
              />
              <div className="flex items-center gap-2 px-3 pb-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{selected.name}</div>
                  <div className="text-[11px] text-white/35">
                    {probe
                      ? `${probe.width}×${probe.height} · ${probe.video_codec} · ${fmtTimecode(probe.duration).slice(0, 8)}`
                      : 'reading header…'}
                  </div>
                  {/* HEVC, MKV and AC3 export fine but may not decode in the
                      browser, and on a phone that is a black frame with no
                      explanation. Say so where it happens. */}
                  {probe && !probe.browser_playable && (
                    <div className="mt-0.5 text-[11px] text-amber-300/80">
                      may not play here · export is unaffected
                    </div>
                  )}
                </div>
                {loaded?.abs === selected.abs ? (
                  <Tap onClick={() => { seekEdit(curTime); say(`Editor → ${fmtTimecode(curTime).slice(0, 8)}`) }}>
                    ⤓ To editor
                  </Tap>
                ) : (
                  <Tap onClick={() => openInEditor(selected)} disabled={exportBusy} tone="accent">
                    ⇤ Editor
                  </Tap>
                )}
              </div>
            </>
          )}
        </section>

        {/* ---- editor ------------------------------------------------------ */}
        <section className="border-t border-white/10 pb-8">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="text-xs font-medium text-white/55">Editor</span>
            <div className="flex-1" />
            {loaded && (
              <Tap onClick={() => { setLoaded(null); say('Editor cleared') }}>✕</Tap>
            )}
          </div>

          {loaded ? (
            <div className="px-3">
              <div className="truncate text-sm">{loaded.name}</div>

              {exportBusy && (
                <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100/90">
                  <span className="font-medium">Export running.</span> Editing is held
                  until it finishes, so the box is doing one job at a time. The running
                  export already has its own copy of the cut list — finishing it is not
                  affected by anything here.
                </div>
              )}

              <div className="mt-2 overflow-hidden rounded-lg bg-black">
                <video
                  key={loaded.abs}
                  ref={editVideoRef}
                  src={srcFor(loaded)}
                  playsInline
                  preload="metadata"
                  className="h-auto w-full"
                  onLoadedMetadata={() => setEditDuration(editVideoRef.current?.duration ?? 0)}
                  onTimeUpdate={() => setEditTime(editVideoRef.current?.currentTime ?? 0)}
                  onSeeked={() => setEditTime(editVideoRef.current?.currentTime ?? 0)}
                />
              </div>

              <ScrubPad
                current={editTime}
                duration={editDuration}
                keyframes={keyframes}
                onSeek={seekEdit}
              />

              <TimeWheel
                time={editTime}
                duration={editDuration}
                fps={fps}
                onChange={seekEdit}
                onSnapKeyframe={keyframes.length
                  ? () => { seekEdit(snapToKeyframe(editTime, keyframes)); say('Snapped to keyframe') }
                  : undefined}
              />

              {/* Undo sits beside Cut, not up in the header: this is where the
                  mistake happens, and on a phone the fix should be under the
                  same thumb that made it. */}
              <div className="mt-2 flex items-stretch gap-2">
                <button
                  onClick={undo}
                  disabled={!canUndo || exportBusy}
                  aria-label="Undo"
                  className="min-h-[52px] w-14 shrink-0 rounded-lg bg-white/10 text-lg transition active:scale-[0.97] disabled:opacity-30"
                >
                  ↶
                </button>
                <button
                  onClick={cutHere}
                  disabled={!editDuration || exportBusy}
                  className="min-h-[52px] flex-1 rounded-lg bg-indigo-500 text-base font-semibold text-white transition active:scale-[0.98] disabled:opacity-30"
                >
                  ✂ Cut here
                </button>
                <button
                  onClick={redo}
                  disabled={!canRedo || exportBusy}
                  aria-label="Redo"
                  className="min-h-[52px] w-14 shrink-0 rounded-lg bg-white/10 text-lg transition active:scale-[0.97] disabled:opacity-30"
                >
                  ↷
                </button>
              </div>

              <button
                onClick={uncutHere}
                disabled={segs.length < 2 || exportBusy}
                className="mt-2 min-h-[44px] w-full rounded-lg bg-white/10 text-sm text-white/80 transition active:scale-[0.98] disabled:opacity-30"
              >
                ⊟ Uncut the nearest cut
              </button>

              {/* ---- segments -------------------------------------------- */}
              <div className="mt-4">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-xs font-medium text-white/55">
                    Segments ({segs.length})
                  </span>
                  <span className="text-[11px] text-white/30">
                    keeping {fmtTimecode(keptDuration(segs)).slice(0, 8)}
                  </span>
                </div>

                {segs.map((s, i) => (
                  <div
                    key={s.id}
                    className={`mb-1 flex items-stretch gap-2 rounded-lg border ${
                      selectedSeg === s.id ? 'border-indigo-400/50' : 'border-white/10'
                    } ${s.keep ? 'bg-white/[0.03]' : 'bg-white/[0.01]'}`}
                  >
                    <button
                      onClick={() => { setSelectedSeg(s.id); seekEdit(s.start) }}
                      className="flex min-h-[52px] min-w-0 flex-1 flex-col justify-center px-3 text-left"
                    >
                      <span className={`font-mono text-xs tabular-nums ${s.keep ? '' : 'text-white/30 line-through'}`}>
                        {fmtTimecode(s.start).slice(0, 8)} → {fmtTimecode(s.end).slice(0, 8)}
                      </span>
                      <span className="text-[11px] text-white/30">
                        #{i + 1} · {fmtTimecode(s.end - s.start).slice(0, 8)}
                      </span>
                    </button>
                    <button
                      onClick={() => apply((cur) => toggleKeep(cur, s.id))}
                      disabled={exportBusy}
                      className={`my-1 mr-1 min-h-[44px] shrink-0 rounded-lg px-4 text-sm active:scale-[0.97] disabled:opacity-40 ${
                        s.keep ? 'bg-white/10 text-white/80' : 'bg-amber-500/20 text-amber-200'
                      }`}
                    >
                      {s.keep ? 'keep' : 'drop'}
                    </button>
                  </div>
                ))}
              </div>

              {/* ---- export ---------------------------------------------- */}
              <div className="mt-5 rounded-lg border border-white/10 p-3">
                <div className="mb-2 text-xs font-medium text-white/55">Export</div>

                <div className="mb-2 flex gap-1">
                  {([
                    ['merge', 'single'],
                    ['separate', 'separate'],
                    ['separate_merge', 'safe join'],
                  ] as const).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => setMode(v)}
                      className={`min-h-[44px] flex-1 rounded-lg text-xs active:scale-[0.97] ${
                        mode === v ? 'bg-indigo-500 text-white' : 'bg-white/10 text-white/70'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="mb-2 truncate text-[11px] text-white/35">
                  {outputDir
                    ? `→ ${outputDir}`
                    : 'No export folder set — do it once in the desktop Settings.'}
                </div>

                <button
                  onClick={startExport}
                  disabled={exporting || !!activeJob || !kept.length || !outputDir.trim()}
                  className="min-h-[52px] w-full rounded-lg bg-indigo-500 text-base font-semibold text-white transition active:scale-[0.98] disabled:opacity-30"
                >
                  {activeJob ? 'Export running…' : `⇩ Export ${kept.length} segment${kept.length === 1 ? '' : 's'}`}
                </button>

                {jobs.slice(0, 3).map((j) => (
                  <div key={j.id} className="mt-2 rounded bg-white/5 p-2 text-[11px]">
                    <div className="flex justify-between">
                      <span className="text-white/60">{j.status}</span>
                      <span className="text-white/35">{Math.round((j.progress ?? 0) * 100)}%</span>
                    </div>
                    {j.message && <div className="mt-0.5 truncate text-white/35">{j.message}</div>}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <div className="text-sm text-white/45">No clip in the editor</div>
              <div className="text-xs text-white/30">
                Pick a film and tap <span className="text-white/50">⇤ Editor</span>.
              </div>
              <Tap onClick={() => setSheet(true)}>📁 Browse files</Tap>
            </div>
          )}
        </section>
      </div>

      {/* ---- file sheet ---------------------------------------------------- */}
      {sheet && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#0b0d12]">
          <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
            <Tap onClick={() => openDir(parent ?? '')} disabled={!parent && cwd === ''}>↑</Tap>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-white/50">{cwd || 'Your library'}</div>
            </div>
            <Tap onClick={() => setSheet(false)}>✕</Tap>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {loading && <div className="p-4 text-sm text-white/40">Loading…</div>}
            {error && (
              <div className="m-3 rounded-lg border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-200">
                {error}
              </div>
            )}
            {!loading && !error && entries.length === 0 && (
              <div className="p-6 text-center text-sm text-white/40">
                Nothing here. Connect a share in the desktop UI's Settings first.
              </div>
            )}

            {[...dirs, ...files].map((e) => (
              <div key={e.abs} className="flex items-stretch gap-2 border-b border-white/5 px-2">
                <button
                  onClick={() => (e.is_dir ? openDir(e.abs) : (setSelected(e), setSheet(false)))}
                  className={`flex min-h-[52px] min-w-0 flex-1 items-center gap-3 px-1 text-left ${
                    selected?.abs === e.abs ? 'text-indigo-300' : ''
                  }`}
                >
                  <span className="w-5 shrink-0 text-white/40">
                    {e.is_dir ? '📁' : e.problem ? '⚠️' : e.is_video ? '🎬' : '📄'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{e.name}</span>
                    <span className="block text-[11px] text-white/30">
                      {[fmtDate(e.mtime), fmtSize(e.size)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
                {!e.is_dir && e.is_video && (
                  <button
                    onClick={() => openInEditor(e)}
                    disabled={exportBusy}
                    title={exportBusy ? 'An export is running' : 'Open in the editor'}
                    className="my-1 shrink-0 rounded-lg bg-white/10 px-3 text-sm active:scale-[0.97] disabled:opacity-30"
                  >
                    ⇤
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-white/15 px-4 py-2 text-xs backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  )
}
