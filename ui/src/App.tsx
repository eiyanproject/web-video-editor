import { useEffect, useMemo, useRef, useState } from 'react'
import Settings from './Settings'
import Logs from './Logs'
import Scrubber, { type SpriteIndex } from './Scrubber'
import MediaInfo, { type Probe } from './MediaInfo'
import Timeline from './Timeline'
import SegmentList from './SegmentList'
import ExportPanel from './ExportPanel'
import Batch from './Batch'
import { useSegments, splitAt, toggleKeep, mergeAt, moveBoundary, snapToKeyframe, normalise, cutCost } from './segments'

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

/** Accepts `1:02:03.500`, `02:03.5`, or plain seconds. Returns null if it is
 *  not a time at all, so a typo does not silently seek to zero. */
function parseTimecode(s: string): number | null {
  const str = s.trim()
  if (!str) return null
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str)
  const m = str.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/)
  if (!m) return null
  const h = m[1] ? parseInt(m[1], 10) : 0
  const min = parseInt(m[2], 10)
  const sec = parseFloat(m[3])
  if (min > 59 || sec >= 60) return null
  return h * 3600 + min * 60 + sec
}

// Timecode spinner.
//
// `HH:MM:SS.mmm` is 12 characters, and which digit the caret sits on decides
// what Up/Down changes — tens of minutes under the caret steps ten minutes, the
// last millisecond digit steps one. That is how every broadcast timecode field
// has worked for decades, and it beats retyping the whole string to nudge a cut
// by a frame.
//
//        0 1 : 3 4 : 6 7 . 9 10 11
//        H H   M M   S S   m m  m
const STEP_BY_CARET = [
  36000, 3600, 3600,   // hours (caret on ':' behaves as the digit to its left)
  600, 60, 60,         // minutes
  10, 1, 1,            // seconds
  0.1, 0.01, 0.001,    // milliseconds
  0.001,               // caret parked at the very end
]

/** Character positions that hold a digit, for caret hopping. */
const DIGIT_POSITIONS = [0, 1, 3, 4, 6, 7, 9, 10, 11]

/**
 * Largest digit each position may hold.
 *
 * Minutes and seconds cannot start with 6-9, because no such time exists. Typing
 * one there is not an error to reject, though - it plainly means "6 minutes", so
 * the tens digit becomes 0, the typed digit lands in the ones, and the caret
 * moves on to the next field. Same as every clock-setting UI worth using.
 */
const MAX_DIGIT: Record<number, number> = {
  0: 9, 1: 9,      // hours
  3: 5, 4: 9,      // minutes
  6: 5, 7: 9,      // seconds
  9: 9, 10: 9, 11: 9,
}

/** Which field a caret position belongs to, and where that field starts. */
const FIELD_OF: Record<number, [number, number]> = {
  0: [0, 1], 1: [0, 1],
  3: [3, 4], 4: [3, 4],
  6: [6, 7], 7: [6, 7],
  9: [9, 11], 10: [9, 11], 11: [9, 11],
}

/** Strips anything that is not part of a timecode. Guards paste and IME input. */
function sanitiseTimecode(v: string): string {
  return v.replace(/[^0-9:.]/g, '').slice(0, 12)
}

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

/**
 * Display aspect of a clip, honouring non-square pixels.
 *
 * Stored width over height is not the shape you see: a 854x480 file with a
 * 1280:1281 sample aspect displays as 16:9. Portrait phone footage is the case
 * that makes this visible - forcing everything into a 16:9 box would show it as
 * a sliver between two black slabs.
 */
function displayAspect(p: { width: number; height: number; sar?: string } | null): number | null {
  if (!p?.width || !p?.height) return null
  let num = 1, den = 1
  const m = (p.sar ?? '').match(/^(\d+):(\d+)$/)
  if (m) { num = Number(m[1]); den = Number(m[2]) }
  if (!num || !den) { num = 1; den = 1 }
  return (p.width * num) / (p.height * den)
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

/** Detents at the quarters. Dragging to a round split is the common intent and
 *  hitting it by hand is fiddly, so anything within 3% lands on it exactly. */
const SNAPS = [0.25, 0.5, 0.75]

function snapFraction(f: number, min = 0.15, max = 0.85) {
  const c = Math.min(max, Math.max(min, f))
  for (const s of SNAPS) if (Math.abs(c - s) < 0.03) return s
  return c
}

/** Shared drag behaviour for both resizable dividers. */
function beginSplitDrag(
  e: React.MouseEvent,
  rowRef: React.RefObject<HTMLDivElement | null>,
  set: (f: number) => void,
) {
  e.preventDefault()
  const onMove = (ev: MouseEvent) => {
    const r = rowRef.current?.getBoundingClientRect()
    if (!r || !r.width) return
    set(snapFraction((ev.clientX - r.left) / r.width))
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
  }
  // Without this a drag across the video selects half the page.
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

const LAST_DIR = 'veditor.lastDir'
const SESSION = 'veditor.session'

type Session = {
  selected?: Entry | null
  loaded?: Entry | null
  time?: number
  /** Editor playhead, separate from the preview player's position. */
  editTime?: number
  /** Whatever is in the Go-to box, kept so a noted timecode survives a reload. */
  tcInput?: string
  /** Player/segment-list split inside the editor, as a fraction. */
  editSplit?: number
  /** Editor pane against the library pane, as a fraction. */
  mainSplit?: number
  muted?: boolean
  sortKey?: SortKey
  sortAsc?: boolean
  showAll?: boolean
}

export default function App() {
  const [page, setPage] = useState<'edit' | 'settings' | 'logs' | 'batch'>('edit')
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
  const [showPaste, setShowPaste] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  // Which pane the keyboard is driving. Kept in state, not just a ref,
  // because an invisible mode is a trap - the panes show which one is live.
  const [activePane, setActivePane] = useState<'editor' | 'preview'>('editor')
  // Export mode lives here so a keystroke can set it and the panel follows.
  const [exportMode, setExportMode] = useState<'merge' | 'separate' | 'separate_merge'>('merge')
  const listRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const pasteRef = useRef<HTMLInputElement>(null)
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
  const [indexing, setIndexing] = useState(false)
  const [peaks, setPeaks] = useState<number[] | undefined>(undefined)
  const [waveBusy, setWaveBusy] = useState(false)
  const [waveAuto, setWaveAuto] = useState(false)

  // ---- Phase 2: the edit ---------------------------------------------------

  // The global key handler is registered once; these refs let it reach the
  // current handlers without re-binding a capture-phase listener every render.
  const probeRef = useRef<Probe | null>(null)
  const selectedRef = useRef<Entry | null>(null)
  const focusListRef = useRef<(() => void) | null>(null)
  const focusFilterRef = useRef<(() => void) | null>(null)
  const openPasteRef = useRef<(() => void) | null>(null)
  const loadIntoEditorRef = useRef<(() => void) | null>(null)
  const transferTimeRef = useRef<(() => void) | null>(null)
  const focusTimecodeRef = useRef<(() => void) | null>(null)
  const snapKeyframeRef = useRef<(() => void) | null>(null)
  const stepSegmentRef = useRef<((d: number) => void) | null>(null)
  const saveEditRef = useRef<(() => void) | null>(null)
  const exportRef = useRef<(() => void) | null>(null)
  /// Which player the keyboard should drive: whichever was last played,
  /// clicked or seeked.
  const lastPlayerRef = useRef<'editor' | 'preview'>('editor')
  const splitRef = useRef<(() => void) | null>(null)
  const toggleRef = useRef<(() => void) | null>(null)
  const undoRef = useRef<(() => void) | null>(null)
  const redoRef = useRef<(() => void) | null>(null)

  // The editor keeps its OWN probe of the loaded clip, independent of whatever
  // the player currently shows. Closing the preview - or previewing a different
  // file - must not disturb an edit in progress.
  const [loadedProbe, setLoadedProbe] = useState<Probe | null>(null)
  const fps = loadedProbe?.fps || 25
  const editDuration = loaded ? (loadedProbe?.duration ?? 0) : 0

  // The editor has its own video feed and its own playhead. Right pane is for
  // finding things; left pane is where you work.
  const editVideoRef = useRef<HTMLVideoElement>(null)
  const [editTime, setEditTime] = useState(0)
  const [tcInput, setTcInput] = useState('')

  // Split between the player and the segment list, as a fraction of the editor
  // pane's width. Draggable, with detents at the thirds.
  const [editSplit, setEditSplit] = useState(0.75)
  const editRowRef = useRef<HTMLDivElement>(null)

  // Split between the editor pane and the library/preview pane.
  const [mainSplit, setMainSplit] = useState(0.5)
  const mainRowRef = useRef<HTMLDivElement>(null)

  // The segment list must never decide how tall the row is - that is what was
  // shoving the timeline off the bottom of the screen once a few cuts existed.
  // Measure the picture and give the list exactly that height to scroll within.
  const [videoH, setVideoH] = useState(0)
  useEffect(() => {
    const el = editVideoRef.current
    if (!el) { setVideoH(0); return }
    const ro = new ResizeObserver(() => setVideoH(el.clientHeight))
    ro.observe(el)
    setVideoH(el.clientHeight)
    return () => ro.disconnect()
  }, [loaded?.abs, editSplit, editDuration])

  const startSplitDrag = (e: React.MouseEvent) => beginSplitDrag(e, editRowRef, setEditSplit)
  const { segs, setSegs, apply, undo, redo, reset, canUndo, canRedo } = useSegments(editDuration, loaded?.abs ?? '')
  const [selectedSeg, setSelectedSeg] = useState<number | null>(null)
  const [outputDir, setOutputDir] = useState('')
  const [autosave, setAutosave] = useState(true)
  const [editSaved, setEditSaved] = useState<string>('')

  // Restore a previously saved cut list for this clip. Runs after useSegments
  // has reset for the new clip, so it wins.
  const editLoadedFor = useRef<string>('')
  useEffect(() => {
    if (!loaded?.abs || !editDuration) return
    const key = loaded.abs
    let cancelled = false
    ;(async () => {
      try {
        const d = await (await fetch(`/api/edit?path=${encodeURIComponent(key)}`)).json()
        if (cancelled || !d || !d.segments?.length) { editLoadedFor.current = key; return }
        setSegs(normalise(d.segments, editDuration))
        editLoadedFor.current = key
        setEditSaved(d.saved_at ? new Date(d.saved_at * 1000).toLocaleString() : '')
        say(d.stale
          ? 'Loaded saved cuts — but the file has changed since, so check them'
          : `Loaded saved cuts (${d.segments.length} segments)`)
      } catch { editLoadedFor.current = key }
    })()
    return () => { cancelled = true }
  }, [loaded?.abs, editDuration])

  const saveEdit = async (quiet = false) => {
    if (!loaded?.abs || !segs.length) return
    try {
      const r = await fetch('/api/edit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: loaded.abs, duration: editDuration, fps,
          segments: segs.map((s) => ({ start: s.start, end: s.end, keep: s.keep })),
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setEditSaved(new Date().toLocaleString())
      if (!quiet) say('Cuts saved')
    } catch (e: any) {
      if (!quiet) setError(String(e.message ?? e))
    }
  }

  // Autosave, debounced. Skipped until the saved edit for this clip has been
  // loaded, or the freshly-reset single segment would overwrite it.
  useEffect(() => {
    if (!autosave || !loaded?.abs || editLoadedFor.current !== loaded.abs) return
    if (segs.length < 1) return
    const t = setTimeout(() => saveEdit(true), 1500)
    return () => clearTimeout(t)
  }, [segs, autosave, loaded?.abs])
  const dragBase = useRef<typeof segs | null>(null)

  const seek = (t: number) => {
    const v = editVideoRef.current
    const clamped = Math.max(0, Math.min(editDuration || v?.duration || 0, t))
    if (v) v.currentTime = clamped
    setEditTime(clamped)
  }

  const tcRef = useRef<HTMLInputElement>(null)

  // Caret position for a controlled input has to be reapplied *after* React has
  // written the new value. requestAnimationFrame fires before that commit, so
  // the browser reset the selection to the end and every digit after the first
  // landed in the wrong field. An effect with no dependency array runs after
  // every render, which is exactly the moment needed.
  const pendingCaret = useRef<number | null>(null)
  const restoreCaret = (pos: number) => { pendingCaret.current = pos }

  useEffect(() => {
    if (pendingCaret.current == null) return
    const el = tcRef.current
    if (el && document.activeElement === el) {
      const p = pendingCaret.current
      el.setSelectionRange(p, p)
    }
    pendingCaret.current = null
  })

  /** Writes one digit at `pos`, returning the new string and where to go next. */
  const applyDigit = (value: string, pos: number, digit: number): [string, number] => {
    const chars = value.split('')
    const max = MAX_DIGIT[pos] ?? 9
    const [fieldStart, fieldEnd] = FIELD_OF[pos] ?? [pos, pos]

    // A digit too large for a tens position means the user typed a whole value:
    // 6 in the minutes tens is "6 minutes", not "6x minutes".
    if (digit > max && pos === fieldStart && fieldEnd > fieldStart) {
      chars[fieldStart] = '0'
      chars[fieldStart + 1] = String(digit)
      const after = DIGIT_POSITIONS.find((d) => d > fieldEnd)
      return [chars.join(''), after ?? fieldEnd]
    }

    chars[pos] = String(Math.min(digit, max))
    const next = DIGIT_POSITIONS.find((d) => d > pos)
    return [chars.join(''), next ?? pos]
  }

  const handleTcKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget
    let caret = el.selectionStart ?? 0

    if (e.key === 'Enter') { goToTypedTime(); return }

    // Typing a digit overwrites the one under the caret and moves on, so the
    // field never grows, never needs the separators typing, and cannot hold a
    // value that is not a time.
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault()
      let base = el.value
      if (!/^\d\d:\d\d:\d\d\.\d\d\d$/.test(base)) {
        base = fmtTimecode(parseTimecode(base) ?? editTime)
      }
      // A full selection means "start again".
      if (el.selectionStart === 0 && el.selectionEnd === base.length) caret = 0
      if (!DIGIT_POSITIONS.includes(caret)) {
        caret = DIGIT_POSITIONS.find((d) => d >= caret) ?? 11
      }
      const [next, nextCaret] = applyDigit(base, caret, Number(e.key))
      const t = parseTimecode(next)
      const clamped = t == null ? editTime : Math.min(t, editDuration || t)
      setTcInput(fmtTimecode(clamped))
      seek(clamped)
      restoreCaret(nextCaret)
      return
    }

    // Backspace zeroes the digit behind the caret rather than deleting a
    // character, which would break the fixed layout the caret arithmetic needs.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      const target = e.key === 'Backspace'
        ? [...DIGIT_POSITIONS].reverse().find((d) => d < caret) ?? 0
        : (DIGIT_POSITIONS.includes(caret) ? caret : DIGIT_POSITIONS.find((d) => d > caret) ?? 11)
      const base = /^\d\d:\d\d:\d\d\.\d\d\d$/.test(el.value)
        ? el.value
        : fmtTimecode(parseTimecode(el.value) ?? editTime)
      const chars = base.split('')
      chars[target] = '0'
      const t = parseTimecode(chars.join(''))
      if (t != null) { setTcInput(fmtTimecode(t)); seek(t) }
      restoreCaret(target)
      return
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const base = parseTimecode(el.value) ?? editTime
      const step = STEP_BY_CARET[Math.min(caret, STEP_BY_CARET.length - 1)] ?? 1
      const next = Math.max(0, Math.min(editDuration || Infinity,
        base + (e.key === 'ArrowUp' ? step : -step)))
      setTcInput(fmtTimecode(next))
      // Seek as it changes: the point of nudging a digit is watching the frame.
      seek(next)
      restoreCaret(caret)
      return
    }

    // Hop between digits, skipping the ':' and '.' separators so every press
    // lands somewhere that Up/Down can actually act on.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.shiftKey) return // leave text selection alone
      const dir = e.key === 'ArrowRight' ? 1 : -1
      const candidates = dir > 0
        ? DIGIT_POSITIONS.filter((p) => p > caret)
        : DIGIT_POSITIONS.filter((p) => p < caret).reverse()
      if (candidates.length) {
        e.preventDefault()
        el.setSelectionRange(candidates[0], candidates[0])
      }
      return
    }
  }

  const goToTypedTime = () => {
    const t = parseTimecode(tcInput)
    if (t == null) { say('Not a time — try 1:02:03.500, 02:03.5 or 123.4'); return }
    if (t > editDuration) { say(`Beyond the end (${fmtTimecode(editDuration).slice(0, 8)})`); return }
    seek(t)
    // Deliberately NOT cleared: a timecode is usually used more than once -
    // nudged a frame, jumped back to, then cut at. Clearing it means retyping.
  }

  // Boundary drags emit continuously; only the final position becomes an undo
  // step, otherwise a single drag would fill the history with hundreds of them.
  const onMoveBoundary = (index: number, t: number, commit: boolean) => {
    if (commit) { dragBase.current = null; return }
    if (!dragBase.current) dragBase.current = segs
    apply((cur) => moveBoundary(dragBase.current ?? cur, index, t))
  }

  const splitHere = () => {
    apply((cur) => splitAt(cur, editTime))
    say(`Cut at ${fmtTimecode(editTime).slice(0, 8)}`)
  }

  const toggleSelected = () => {
    const id = selectedSeg ?? segs.find((s) => editTime >= s.start && editTime < s.end)?.id
    if (id != null) apply((cur) => toggleKeep(cur, id))
  }

  probeRef.current = probe
  selectedRef.current = selected

  // --- keyboard actions -----------------------------------------------------
  focusListRef.current = () => {
    const first = listRef.current?.querySelector<HTMLButtonElement>('button[data-row]')
    first?.focus()
  }
  focusFilterRef.current = () => filterRef.current?.focus()
  openPasteRef.current = () => setShowPaste(true)
  loadIntoEditorRef.current = () => {
    if (!selected || selected.is_dir) { say('Select a video first'); return }
    setLoaded(selected); say(`Loaded ${selected.name}`)
  }
  // The move their workflow actually turns on: take where the preview is and
  // put the editor there, with the timecode filled in ready to nudge.
  transferTimeRef.current = () => {
    const t = videoRef.current?.currentTime
    if (t == null) { say('Nothing playing in the preview'); return }
    setTcInput(fmtTimecode(t))
    if (editVideoRef.current) { editVideoRef.current.currentTime = t; setEditTime(t) }
    say(`Editor moved to ${fmtTimecode(t).slice(0, 8)}`)
  }
  focusTimecodeRef.current = () => {
    tcRef.current?.focus()
    tcRef.current?.setSelectionRange(6, 6)   // land on seconds, the usual target
  }
  snapKeyframeRef.current = () => {
    if (!keyframes.length) { say('No keyframe index yet'); return }
    const t = snapToKeyframe(editTime, keyframes)
    seek(t); setTcInput(fmtTimecode(t))
    say(`Snapped to keyframe ${fmtTimecode(t).slice(0, 8)}`)
  }
  stepSegmentRef.current = (d: number) => {
    if (!segs.length) return
    const cur = segs.findIndex((x) => x.id === selectedSeg)
    const next = Math.max(0, Math.min(segs.length - 1, (cur < 0 ? 0 : cur) + d))
    const seg = segs[next]
    setSelectedSeg(seg.id); seek(seg.start)
    say(`Segment ${next + 1} of ${segs.length}${seg.keep ? '' : ' (dropped)'}`)
  }
  saveEditRef.current = () => saveEdit(false)
  splitRef.current = splitHere
  toggleRef.current = toggleSelected
  undoRef.current = undo
  redoRef.current = redo

  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000) }

  // SELECTING a file is metadata-only. ffprobe reads headers, not the file, so
  // browsing a folder of fifty clips costs nothing.
  useEffect(() => {
    setProbe(null); setDeep(null); setPeaks(undefined)
    if (waveTimer.current) { clearTimeout(waveTimer.current); waveTimer.current = null }
    if (!selected || selected.is_dir) return
    // Cached waveforms are free, so always look. Generating one means reading
    // the whole file, so that only happens when the switch is on.
    const wpath = selected.abs
    fetch(`/api/waveform?peek=true&path=${encodeURIComponent(wpath)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.peaks?.length) { setPeaks(d.peaks); return }
        // Wait until the selection settles. Clicking down a folder would
        // otherwise start a full read for every file passed through.
        if (waveAutoRef.current) {
          waveTimer.current = window.setTimeout(() => {
            if (selectedRef.current?.abs === wpath) buildWaveformFor(wpath)
          }, 2500)
        }
      })
      .catch(() => {})
    let cancelled = false
    ;(async () => {
      setAnalyzing(true)
      try {
        const p = await (await fetch(`/api/probe?path=${encodeURIComponent(selected.abs)}`)).json()
        if (cancelled) return
        if (p.error) { setError(`Could not analyse this file: ${p.error}`); return }
        setProbe(p)
      } catch { /* surfaced by the error banner if it matters */ }
      finally { if (!cancelled) setAnalyzing(false) }
    })()
    return () => { cancelled = true }
  }, [selected?.abs])

  // LOADING into the editor is where the file actually gets read. The keyframe
  // index demuxes end to end - 8s for a 25-minute clip over SMB, and a full
  // multi-GB read for a feature. That is fine when you have committed to
  // editing this file; it is not fine merely for clicking on it.
  useEffect(() => {
    setKeyframes([]); setAvgGap(0); setSprites(null); setLoadedProbe(null)
    if (!loaded || loaded.is_dir) return
    let cancelled = false
    const q = (u: string) => `${u}?path=${encodeURIComponent(loaded.abs)}`
    ;(async () => {
      setIndexing(true)
      try {
        const lp = await (await fetch(q('/api/probe'))).json()
        if (cancelled) return
        if (!lp.error) setLoadedProbe(lp)

        const k = await (await fetch(q('/api/keyframes'))).json()
        if (cancelled || k.error) return
        setKeyframes(k.times ?? []); setAvgGap(k.avg_gap ?? 0)
        // Cache-only: never starts a sprite build.
        const s: SpriteIndex = await (await fetch(q('/api/sprites') + '&peek=true')).json()
        if (!cancelled && s && s.done && s.sheets > 0) setSprites(s)
      } catch { /* ignored: the scrubber simply has no ticks */ }
      finally { if (!cancelled) setIndexing(false) }
    })()
    return () => { cancelled = true }
  }, [loaded?.abs])

  // Arrow keys jump 5 seconds.
  //
  // Registered in the CAPTURE phase and stopping propagation, because the
  // browser's own <video controls> handles arrows itself the moment the player
  // has focus - and its step is not 5s. Listening on the bubble phase means the
  // native handler has already run and won.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)

      // Tab moves between the two panes. Taken even when a file row has focus,
      // but never inside a text field, so forms still tab normally.
      if (e.key === 'Tab' && !typing) {
        e.preventDefault()
        const next = lastPlayerRef.current === 'editor' ? 'preview' : 'editor'
        lastPlayerRef.current = next
        setActivePane(next)
        const target = next === 'editor' ? editVideoRef.current : videoRef.current
        target?.focus?.()
        return
      }
      if (typing) return

      const wantEditor = lastPlayerRef.current !== 'preview'
      const v = (wantEditor ? editVideoRef.current : videoRef.current)
        ?? editVideoRef.current ?? videoRef.current
      if (!v) return
      const isEditor = v === editVideoRef.current

      // Frame stepping. The step is 1/fps of the loaded clip, so fractional
      // rates (23.976, 29.97) land on real frames instead of drifting.
      const frame = 1 / (probeRef.current?.fps || 25)
      const jump = (d: number) => {
        e.preventDefault(); e.stopPropagation()
        const t = Math.max(0, Math.min(v.duration || 0, v.currentTime + d))
        v.currentTime = t
        isEditor ? setEditTime(t) : setCurTime(t)
      }

      // Only keys the browser would otherwise act on get cancelled. A plain
      // letter has no default worth taking, so those are left alone and every
      // browser shortcut, extension and accessibility tool keeps working.
      const take = () => { e.preventDefault(); e.stopPropagation() }

      if (e.ctrlKey || e.metaKey) {
        // Ctrl + arrows: one second, for placing a cut without hunting.
        if (e.key === 'ArrowRight') { take(); return jump(1) }
        if (e.key === 'ArrowLeft') { take(); return jump(-1) }
        switch (e.key.toLowerCase()) {
          case 'z': take(); e.shiftKey ? redoRef.current?.() : undoRef.current?.(); return
          case 's': take(); saveEditRef.current?.(); return   // browser save
          case 'enter': exportRef.current?.(); return
        }
        return
      }
      if (e.altKey) return   // leave browser navigation alone

      switch (e.key) {
        case 'ArrowRight': take(); return jump(5)
        case 'ArrowLeft': take(); return jump(-5)
        case '.': return jump(frame)
        case ',': return jump(-frame)
        case ' ':
          take()   // stops the page scrolling
          v.paused ? v.play().catch(() => {}) : v.pause(); return

        // --- moving around ---
        case 'f': case 'F': focusListRef.current?.(); return
        case '/': take(); focusFilterRef.current?.(); return   // Firefox quick-find
        case 'p': case 'P': openPasteRef.current?.(); return
        case 'l': case 'L': loadIntoEditorRef.current?.(); return

        // --- carrying a time from the preview into the editor ---
        case 't': case 'T': transferTimeRef.current?.(); return
        case 'g': case 'G': focusTimecodeRef.current?.(); return
        case 'k': case 'K': snapKeyframeRef.current?.(); return

        // --- cutting ---
        // X for cut, as in cut-and-paste everywhere else. S still works, since
        // that is what video editors tend to use for split.
        case 'x': case 'X': case 's': case 'S': splitRef.current?.(); return
        case 'Delete': toggleRef.current?.(); return
        case 'Backspace': take(); toggleRef.current?.(); return  // used to go back
        case '[': stepSegmentRef.current?.(-1); return
        case ']': stepSegmentRef.current?.(1); return

        // --- export mode, then go ---
        case '1': setExportMode('merge'); say('Export: single file'); return
        case '2': setExportMode('separate'); say('Export: separate files'); return
        case '3': setExportMode('separate_merge'); say('Export: safe join'); return

        case '?': setShowHelp((h) => !h); return
        case 'Escape': setShowHelp(false); return
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The mouse back button navigates UP A FOLDER rather than leaving the app.
  //
  // This is a single-page editor with no meaningful URL history, so browser
  // back has nothing useful to do - and losing your session mid-edit because a
  // thumb button was nudged would be miserable. A sentinel history entry is
  // pushed and immediately re-pushed on every popstate, so back is absorbed
  // whatever triggered it: mouse thumb button, Alt+Left, or the browser chrome.
  const parentRef = useRef<string | null>(null)
  useEffect(() => { parentRef.current = parent }, [parent])
  const showAllRef = useRef(showAll)
  useEffect(() => { showAllRef.current = showAll }, [showAll])

  useEffect(() => {
    history.pushState({ wve: true }, '', location.href)
    const onPop = () => {
      history.pushState({ wve: true }, '', location.href) // stay put
      const p = parentRef.current
      if (p) openDir(p, showAllRef.current)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Opening the path drawer should put the cursor in it - otherwise you reach
  // for the mouse again immediately after clicking a button.
  useEffect(() => {
    if (showPaste) pasteRef.current?.focus()
  }, [showPaste])

  const waveTimer = useRef<number | null>(null)
  const waveAutoRef = useRef(false)
  waveAutoRef.current = waveAuto

  const buildWaveformFor = async (path: string) => {
    setWaveBusy(true)
    try {
      const r = await fetch(`/api/waveform?path=${encodeURIComponent(path)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      // The clip may have changed while a long read was in flight.
      if (selectedRef.current?.abs === path) setPeaks(d.peaks)
    } catch { /* no waveform is not worth an error banner */ }
    finally { setWaveBusy(false) }
  }

  const toggleWaveAuto = async () => {
    const next = !waveAuto
    setWaveAuto(next)
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ waveform_auto: next }),
    }).catch(() => {})
    if (next && selected && !peaks?.length) buildWaveformFor(selected.abs)
    if (!next) say('Waveform off — cached ones still show, and expire after an hour')
  }

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
  // The export folder is one setting shared by the Settings page and the export
  // panel. Whichever edits it wins, and the other must see it - previously the
  // panel kept a private copy that was never written back, so the two drifted.
  const serverOutputDir = useRef<string | null>(null)

  const loadRoots = () =>
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        setRoots(d.roots ?? [])
        serverOutputDir.current = d.output_dir ?? ''
        setOutputDir(d.output_dir ?? '')
        setAutosave(d.autosave_edits ?? true)
        setWaveAuto(d.waveform_auto ?? false)
      })
      .catch(() => {})

  // Persist an export folder typed into the panel, debounced. Guarded against
  // echoing back what the server just sent us.
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

  useEffect(() => { loadRoots() }, [])

  // ---- session persistence -------------------------------------------------
  // Restoring the open clip and its playback position across a reload. The file
  // is verified to still exist first: a share that is not mounted yet, or a file
  // that has moved, must not leave a broken player and a dead path on screen.
  const pendingSeek = useRef<{ abs: string; t: number } | null>(null)
  const pendingEditSeek = useRef<number | null>(null)

  // Nothing may be written until the stored session has been read.
  //
  // Without this the writer fires on mount with everything still at its initial
  // value and flattens the saved position to zero. Under StrictMode the restore
  // effect then runs a second time and reads back its own zero, so the restore
  // silently succeeds at restoring nothing.
  const restoreStarted = useRef(false)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    if (restoreStarted.current) return
    restoreStarted.current = true

    let s: Session
    try {
      const raw = localStorage.getItem(SESSION)
      if (!raw) { setHydrated(true); return }
      s = JSON.parse(raw)
    } catch { setHydrated(true); return }

    if (s.muted != null) setMuted(s.muted)
    if (s.tcInput) setTcInput(s.tcInput)
    if (typeof s.editSplit === 'number' && s.editSplit > 0.1 && s.editSplit < 0.9) setEditSplit(s.editSplit)
    if (typeof s.mainSplit === 'number' && s.mainSplit > 0.1 && s.mainSplit < 0.9) setMainSplit(s.mainSplit)
    if (s.editTime != null) pendingEditSeek.current = s.editTime
    if (s.sortKey) setSortKey(s.sortKey)
    if (s.sortAsc != null) setSortAsc(s.sortAsc)
    if (s.showAll != null) setShowAll(s.showAll)

    const sel = s.selected
    if (!sel?.abs) {
      if (s.loaded?.abs) setLoaded(s.loaded)
      setHydrated(true)
      return
    }
    fetch(`/api/resolve?path=${encodeURIComponent(sel.abs)}`)
      .then((r) => {
        if (!r.ok) throw new Error('gone')
        pendingSeek.current = { abs: sel.abs, t: s.time ?? 0 }
        setSelected(sel)
        if (s.loaded?.abs) setLoaded(s.loaded)
      })
      .catch(() => {
        // Silently forget it. Announcing "the file you had open is missing" on
        // every cold start when a share is simply not up yet would be noise.
        try { localStorage.removeItem(SESSION) } catch { /* ignore */ }
      })
      .finally(() => setHydrated(true))
  }, [])

  // Latest values for the periodic writer, so playback position is saved
  // without re-registering a timer four times a second.
  const sessionRef = useRef<Session>({})
  sessionRef.current = { selected, loaded, time: curTime, editTime, tcInput, editSplit, mainSplit, muted, sortKey, sortAsc, showAll }
  const writeSession = () => {
    if (!hydratedRef.current) return
    try { localStorage.setItem(SESSION, JSON.stringify(sessionRef.current)) } catch { /* quota */ }
  }
  const hydratedRef = useRef(false)
  hydratedRef.current = hydrated

  useEffect(() => {
    window.addEventListener('beforeunload', writeSession)
    return () => { window.removeEventListener('beforeunload', writeSession); writeSession() }
  }, [])

  // Throttled by a coarse bucket of the playhead rather than a timer: the write
  // is driven by React state, so it can never read a stale closure, and a
  // paused video (which emits no timeupdate) still persists correctly because
  // seeking changes the bucket. Debouncing would be wrong here - during
  // continuous playback it never settles, so it would never write at all.
  const timeBucket = Math.floor(curTime / 3)
  const editBucket = Math.floor(editTime / 3)
  useEffect(() => {
    writeSession()
  }, [hydrated, timeBucket, editBucket, tcInput, editSplit, mainSplit, selected?.abs, loaded?.abs, muted, sortKey, sortAsc, showAll])

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
      setShowPaste(false)
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
  if (page === 'batch') return <Batch onClose={() => setPage('edit')} />
  if (page === 'settings')
    return <Settings startWithShare={wantShare}
      onClose={() => { setWantShare(false); setPage('edit'); loadRoots(); openDir('') }} />

  return (
    <div className="flex h-full w-full flex-col">
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setShowHelp(false)}>
          <div onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg border border-white/15 bg-[#12141a] p-5 shadow-xl">
            <div className="mb-3 flex items-center">
              <h2 className="text-base font-semibold">Keyboard</h2>
              <span className="ml-2 text-xs text-white/35">the whole flow, without the mouse</span>
              <div className="flex-1" />
              <button onClick={() => setShowHelp(false)}
                className="rounded px-2 text-white/40 hover:bg-white/10 hover:text-white">✕</button>
            </div>
            <div className="grid gap-x-8 gap-y-4 text-xs sm:grid-cols-2">
              {([
                ['Find the film', [
                  ['F', 'jump into the file list'],
                  ['↑ ↓', 'move through it · Enter opens'],
                  ['/', 'filter this folder'],
                  ['P', 'paste a path'],
                ]],
                ['Watch it', [
                  ['Tab', 'switch pane — the lit edge shows which'],
                  ['Space', 'play / pause'],
                  ['← →', 'jump 5 seconds'],
                  ['Ctrl+← →', 'one second'],
                  [', .', 'one frame'],
                ]],
                ['Take it to the editor', [
                  ['L', 'load the selected clip'],
                  ['T', 'move the editor to where the preview is'],
                  ['G', 'jump into the timecode box'],
                  ['0-9', 'in the box: type digits, HH → MM → SS → ms'],
                  ['↑ ↓', 'in the box: change the digit under the cursor'],
                  ['← →', 'in the box: move between digits'],
                  ['K', 'snap to the nearest keyframe'],
                ]],
                ['Cut', [
                  ['X or S', 'cut at the playhead'],
                  ['[ ]', 'previous / next segment'],
                  ['Del', 'keep or drop that segment'],
                  ['Ctrl+Z', 'undo · Shift to redo'],
                  ['Ctrl+S', 'save the cut list'],
                ]],
                ['Export', [
                  ['1', 'single file'],
                  ['2', 'separate files'],
                  ['3', 'safe join'],
                  ['Ctrl+Enter', 'start the export'],
                ]],
                ['Anywhere', [
                  ['?', 'this list'],
                  ['Esc', 'close'],
                ]],
              ] as const).map(([group, rows]) => (
                <div key={group}>
                  <div className="mb-1 font-medium text-white/70">{group}</div>
                  {rows.map(([k, what]) => (
                    <div key={k} className="flex gap-2 py-0.5">
                      <kbd className="min-w-[4.5rem] shrink-0 rounded bg-white/10 px-1.5 text-center font-mono text-[11px] text-white/80">{k}</kbd>
                      <span className="text-white/50">{what}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="mt-4 border-t border-white/10 pt-2 text-[11px] text-white/30">
              Typing in a box? Only Esc and Enter are taken — everything else is yours.
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="absolute left-1/2 top-3 z-50 -translate-x-1/2 rounded bg-emerald-500/90 px-3 py-1.5 text-xs text-white shadow">
          {toast}
        </div>
      )}
      <div ref={mainRowRef} className="flex min-h-0 flex-1">
        {/* ---------------- left: editor ------------------------------- */}
        {/* A thin bar marks which pane the keyboard is driving. Tab switches. */}
        <div className={`flex min-w-0 flex-col border-t-2 ${
          activePane === 'editor' ? 'border-indigo-400/70' : 'border-transparent'
        }`} style={{ width: `${mainSplit * 100}%` }}>
          <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5 text-xs">
            <button className="rounded bg-indigo-500/80 px-3 py-1 font-medium text-white">Trim</button>
            <button onClick={() => setPage('batch')}
              title="Convert whole files between containers, in bulk"
              className="rounded px-3 py-1 text-white/50 hover:bg-white/10 hover:text-white">
              Batch remux
            </button>
            <div className="flex-1" />
            <Btn title="Keyboard shortcuts (?)" onClick={() => setShowHelp(true)}>⌨ ?</Btn>
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
            className="flex min-h-0 flex-1 flex-col"
          >
            {loaded && editDuration > 0 ? (
              <>
                <div className="truncate border-b border-white/10 px-3 py-1.5 text-xs text-white/60">
                  {loaded.name}
                </div>

                {/* Movavi layout: preview on the left, segment list down the
                    right, timeline spanning the bottom. */}
                {/* shrink-0, not flex-1: the row is exactly as tall as the
                    picture, so the controls sit hard against the player instead
                    of floating below a column of empty black. */}
                <div ref={editRowRef} className="flex shrink-0">
                  <div className="min-w-0 bg-black" style={{ width: `${editSplit * 100}%` }}>
                    {/* No max-height: clamping the height of a w-full video
                        reintroduces the letterbox it was meant to remove. */}
                    <div className="w-full bg-black">
                      <video
                        ref={editVideoRef}
                        key={loaded.abs}
                        src={`/api/stream?path=${encodeURIComponent(loaded.abs)}`}
                        controls
                        preload="metadata"
                        className={
                          (displayAspect(loadedProbe) ?? 2) < 1
                            ? 'mx-auto block max-h-[52vh] w-auto'
                            : 'block h-auto w-full'
                        }
                        onLoadedMetadata={() => {
                          const v = editVideoRef.current
                          const t = pendingEditSeek.current
                          if (v && t != null && t > 1 && t < (v.duration || 0)) {
                            v.currentTime = t
                            setEditTime(t)
                          }
                          pendingEditSeek.current = null
                        }}
                        onPlay={() => { lastPlayerRef.current = 'editor'; setActivePane('editor') }}
                        onClick={() => { lastPlayerRef.current = 'editor'; setActivePane('editor') }}
                        onSeeking={() => { lastPlayerRef.current = 'editor'; setActivePane('editor') }}
                        onTimeUpdate={() => setEditTime(editVideoRef.current?.currentTime ?? 0)}
                        onSeeked={() => setEditTime(editVideoRef.current?.currentTime ?? 0)}
                      />
                    </div>
                  </div>

                  {/* Drag handle. Double-click restores the default 75/25. */}
                  <div
                    onMouseDown={startSplitDrag}
                    onDoubleClick={() => setEditSplit(0.75)}
                    title="Drag to resize · snaps at 25%, 50%, 75% · double-click to reset"
                    className="group relative w-1 shrink-0 cursor-col-resize bg-white/10 hover:bg-indigo-400/60"
                  >
                    <div className="absolute inset-y-0 -left-1 -right-1" />
                  </div>

                  <div
                    className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-white/10"
                    style={videoH ? { height: videoH } : undefined}
                  >
                    <SegmentList
                      segs={segs}
                      duration={editDuration}
                      keyframes={keyframes}
                      fps={fps}
                      selectedId={selectedSeg}
                      onSelect={setSelectedSeg}
                      onToggle={(id) => apply((cur) => toggleKeep(cur, id))}
                      onSeek={seek}
                      onMerge={(i) => apply((cur) => mergeAt(cur, i))}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1 border-t border-white/10 px-2 py-1.5 text-xs">
                  <Btn title="Cut at the playhead (S)" tone="accent" onClick={splitHere}>✂ Cut here</Btn>
                  <Btn title="Exclude or restore the selected segment (Del)" onClick={toggleSelected}>🗑 Keep / drop</Btn>
                  <div className="mx-1 h-4 w-px bg-white/15" />
                  <Btn title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>↶</Btn>
                  <Btn title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>↷</Btn>
                  <Btn title="Remove every cut and start again" onClick={reset}>Reset</Btn>
                  <div className="mx-1 h-4 w-px bg-white/15" />
                  <Btn title="Save this cut list to the share so it comes back next time"
                    tone="accent" onClick={() => saveEdit(false)}>💾 Save cuts</Btn>
                  {editSaved && <span className="text-[10px] text-white/25">saved {editSaved}</span>}
                  <div className="flex-1" />
                  <span className="font-mono text-[11px] text-emerald-300">{fmtTimecode(editTime)}</span>
                  <span className="text-[10px] text-white/25">frame {Math.round(editTime * fps)}</span>
                </div>

                {/* Typed timecode: the mouse cannot land on a specific frame of a
                    two-hour clip, and a cut point often comes from a note. */}
                <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5 text-xs">
                  <input
                    ref={tcRef}
                    value={tcInput}
                    onChange={(e) => setTcInput(sanitiseTimecode(e.target.value))}
                    inputMode="numeric"
                    onFocus={() => {
                      // Normalise to the full form so every digit has a fixed
                      // position for the caret arithmetic to rely on.
                      const t = parseTimecode(tcInput)
                      setTcInput(fmtTimecode(t ?? editTime))
                    }}
                    onKeyDown={handleTcKey}
                    title="↑↓ adjusts the digit under the cursor · ←→ moves between digits · Enter jumps"
                    placeholder="Go to  1:02:03.500 · 02:03.5 · 123.4"
                    className="w-56 rounded bg-white/10 px-2 py-1 font-mono outline-none placeholder:font-sans placeholder:text-white/25"
                  />
                  <span className="text-[10px] text-white/25">↑↓ digit · ←→ move</span>
                  <Btn title="Jump to the typed time" onClick={goToTypedTime}>Go</Btn>
                  <Btn title="Put the current playhead time in the box, to nudge and re-enter"
                    onClick={() => setTcInput(fmtTimecode(editTime))}>⤴ Current</Btn>
                  <Btn title="Jump to the typed time and cut there"
                    onClick={() => {
                      const t = parseTimecode(tcInput)
                      if (t == null || t > editDuration) { say('Not a valid time for this clip'); return }
                      seek(t); apply((cur) => splitAt(cur, t))
                      say(`Cut at ${fmtTimecode(t).slice(0, 8)}`)
                    }}>✂ Cut at time</Btn>
                  <div className="flex-1" />
                  <Btn title="Snap the playhead to the nearest keyframe — a cut here is free"
                    disabled={!keyframes.length}
                    onClick={() => { const t = snapToKeyframe(editTime, keyframes); seek(t); say(`Snapped to keyframe ${fmtTimecode(t).slice(0, 8)}`) }}>
                    ⇥ Nearest keyframe
                  </Btn>
                </div>

                <Timeline
                  duration={editDuration}
                  current={editTime}
                  segs={segs}
                  keyframes={keyframes}
                  fps={fps}
                  onSeek={seek}
                  onMoveBoundary={onMoveBoundary}
                  onSelectSegment={setSelectedSeg}
                  selectedId={selectedSeg}
                />

                <div className="flex items-center gap-1 border-y border-white/10 px-2 py-1 text-[11px] text-white/40">
                  <span>step</span>
                  <Btn title="Back one frame (,)" onClick={() => seek(editTime - 1 / fps)}>◀|</Btn>
                  <Btn title="Forward one frame (.)" onClick={() => seek(editTime + 1 / fps)}>|▶</Btn>
                  <Btn title="Back 5s (←)" onClick={() => seek(editTime - 5)}>−5s</Btn>
                  <Btn title="Forward 5s (→)" onClick={() => seek(editTime + 5)}>+5s</Btn>
                  <div className="flex-1" />
                  <span className="text-white/20">S cut · Del keep/drop · , . frame · Space play</span>
                </div>

                {/* Slack goes here, below everything, so the export strip stays
                    pinned to the bottom and the tools stay together up top. */}
                <div className="min-h-0 flex-1" />

                <ExportPanel
                  source={loaded.abs}
                  segs={segs}
                  outputDir={outputDir}
                  onSetOutputDir={setOutputDir}
                  onToast={say}
                  mode={exportMode}
                  onSetMode={setExportMode}
                  startRef={exportRef}
                  canExact={!!loadedProbe?.smartcut_ok}
                  reencodeSecs={segs.slice(0, -1).reduce((n, s) =>
                    n + cutCost(s.end, keyframes, fps).reencode, 0)}
                />
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-white/30">
                <div>No clip loaded</div>
                <div className="text-xs text-white/20">
                  Select one on the right and press “Load into editor”, or drag it here
                </div>
                {loaded && !editDuration && (
                  <div className="text-xs text-amber-300/70">Reading {loaded.name}…</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Resizes the editor against the library, same detents as the inner
            divider so both behave identically. */}
        <div
          onMouseDown={(e) => beginSplitDrag(e, mainRowRef, setMainSplit)}
          onDoubleClick={() => setMainSplit(0.5)}
          title="Drag to resize · snaps at 25%, 50%, 75% · double-click to reset"
          className="w-1.5 shrink-0 cursor-col-resize bg-white/10 hover:bg-indigo-400/60"
        />

        {/* ---------------- right: library + player -------------------- */}
        <div className={`flex min-w-0 flex-1 flex-col border-t-2 ${
          activePane === 'preview' ? 'border-indigo-400/70' : 'border-transparent'
        }`}>
          {/* One navigation row: actions and location together, because they are
              the same concern. The path scrolls horizontally rather than
              wrapping, so the row never grows and steals height from the player. */}
          {/* Above the player: location only. The controls that act on the
              folder live with the folder, further down. */}
          <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5 text-xs">
            <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap
                            [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <button onClick={() => openDir('')}
                className="shrink-0 rounded px-1 text-white/50 hover:bg-white/10 hover:text-white">
                Library
              </button>
              {crumbs.map((c) => (
                <span key={c.path} className="flex shrink-0 items-center gap-0.5">
                  <span className="text-white/20">/</span>
                  <button onClick={() => openDir(c.path)}
                    className="max-w-[16rem] truncate rounded px-1 text-white/60 hover:bg-white/10 hover:text-white">
                    {c.name}
                  </button>
                </span>
              ))}
              {loading && <span className="ml-2 shrink-0 text-white/30">loading…</span>}
            </div>

            <Btn title="Open a path directly (paste from Explorer, a UNC share, or any absolute path)"
              active={showPaste}
              onClick={() => setShowPaste(!showPaste)}>
              {showPaste ? '▴' : '▾'} Path
            </Btn>
          </div>

          {/* Hidden by default: this is occasional-use, and the player wants the room. */}
          {showPaste && (
            <div className="flex gap-2 border-b border-white/10 px-2 py-1.5">
              <input
                ref={pasteRef}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') goToPasted()
                  if (e.key === 'Escape') { setShowPaste(false); setPasted('') }
                }}
                placeholder="Paste any path…  \\NAS\media\clip.mp4  or  /mnt/smb/nas"
                className="flex-1 rounded bg-white/10 px-2 py-1 text-sm outline-none placeholder:text-white/25"
              />
              <Btn title="Open the pasted path" tone="accent" onClick={goToPasted}>Go</Btn>
              <Btn title="Close (Esc)" onClick={() => { setShowPaste(false); setPasted('') }}>✕</Btn>
            </div>
          )}

          {/* Fully independent of the editor's player, including when it is the
              same file: browsing and cutting are different jobs with different
              playheads, and sharing one element makes both worse. */}
          <div
            className="mx-auto w-full bg-black"
            style={{
              aspectRatio: String(displayAspect(probe) ?? 16 / 9),
              // Portrait clips would otherwise run the full height of the pane
              // and shove the file list off the screen.
              maxHeight: '52vh',
              width: (displayAspect(probe) ?? 2) < 1 ? 'auto' : '100%',
            }}
          >
            {srcUrl ? (
              <video key={srcUrl} ref={videoRef} src={srcUrl} controls preload="metadata"
                muted={muted} className="h-full w-full"
                onPlay={() => { lastPlayerRef.current = 'preview'; setActivePane('preview') }}
                onClick={() => { lastPlayerRef.current = 'preview'; setActivePane('preview') }}
                onSeeking={() => { lastPlayerRef.current = 'preview'; setActivePane('preview') }}
                onLoadedMetadata={() => {
                  setPlayError(null)
                  const v = videoRef.current
                  if (!v) return
                  setDuration(v.duration ?? 0)
                  // Resume where the last session left off. Only once per file,
                  // and only if it is the file the position was recorded for.
                  const ps = pendingSeek.current
                  if (ps && selected && ps.abs === selected.abs && ps.t > 1 && ps.t < (v.duration || 0)) {
                    v.currentTime = ps.t
                    setCurTime(ps.t)
                    say(`Resumed at ${fmtTimecode(ps.t).slice(0, 8)}`)
                  }
                  pendingSeek.current = null
                }}
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
              // Ticks belong to the loaded clip, so they are only shown when the
              // thing you are previewing is the thing you are editing.
              keyframes={loaded?.abs === selected.abs ? keyframes : []}
              sprites={loaded?.abs === selected.abs ? sprites : null}
              peaks={peaks}
              indexing={indexing && loaded?.abs === selected.abs}
              loadedForEditing={loaded?.abs === selected.abs}
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
            <Btn title="Close this video and free the player" disabled={!selected}
              onClick={() => {
                // Pausing and clearing the source first stops the browser from
                // continuing to pull the file over the network after unload.
                const v = videoRef.current
                if (v) { v.pause(); v.removeAttribute('src'); v.load() }
                // The waveform belonged to this editing session; closing the
                // clip is the natural moment to throw it away.
                if (selected) {
                  fetch(`/api/waveform?path=${encodeURIComponent(selected.abs)}`, { method: 'DELETE' })
                    .catch(() => {})
                }
                if (waveTimer.current) { clearTimeout(waveTimer.current); waveTimer.current = null }
                // Player state only. The editor keeps its clip and its cuts.
                setSelected(null); setCurTime(0); setDuration(0); setPeaks(undefined)
                setProbe(null); setDeep(null); setPlayError(null)
                say(loaded ? 'Preview closed — your edit is untouched' : 'Video closed')
              }}>
              ⏏ Unload
            </Btn>
            <Btn
              title="Generate hover thumbnails for this file. Reads the entire file once, so it is slow over a network share — do it for files you are actually editing."
              disabled={!selected} onClick={rebuildThumbs}>
              {sprites?.done ? '⟳ Thumbs' : '🖼 Thumbs'}
            </Btn>
            <Btn
              title="Draw the audio envelope on the scrub bar automatically. Each clip is read once (seconds to a minute), cached at about 20 kB, and the cache expires after an hour. Off means nothing is ever read for this."
              active={waveAuto}
              disabled={waveBusy} onClick={toggleWaveAuto}>
              {waveBusy ? '〜 …' : waveAuto ? '〜 Wave on' : '〜 Wave off'}
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

          {/* Folder explorer toolbar: navigation and view controls together,
              directly above the listing they act on. */}
          <div className="flex flex-wrap items-center gap-1 border-y border-white/10 bg-white/[0.02] px-2 py-1.5 text-xs">
            <Btn title="Show library folders" onClick={() => openDir('')}>⌂</Btn>
            <Btn title="Go to the parent folder (or your mouse back button)"
              disabled={!parent} onClick={() => openDir(parent!)}>↑</Btn>
            <Btn title="Re-read this folder from disk" onClick={() => { openDir(cwd); say('Refreshed') }}>⟳</Btn>
            <Btn title="Add this folder to your library permanently" disabled={!cwd} onClick={addCwdToLibrary}>★</Btn>
            <Btn title="Copy this folder's path" disabled={!cwd} onClick={() => copy(cwd, 'Folder path')}>⧉</Btn>

            {!atHome && (
              <>
                <div className="mx-1 h-4 w-px shrink-0 bg-white/15" />
                <input ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter…"
                  className="w-32 rounded bg-white/10 px-2 py-1 outline-none placeholder:text-white/25" />
                {filter && <Btn title="Clear the filter" onClick={() => setFilter('')}>✕</Btn>}
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
              </>
            )}
          </div>

          <div
            ref={listRef}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
              e.preventDefault(); e.stopPropagation()
              const rows = Array.from(
                listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-row]') ?? [],
              )
              const i = rows.indexOf(document.activeElement as HTMLButtonElement)
              const next = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
              rows[next]?.focus()
              rows[next]?.scrollIntoView({ block: 'nearest' })
            }}
            className="min-h-0 flex-1 overflow-auto text-sm"
          >
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
                  data-row
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
