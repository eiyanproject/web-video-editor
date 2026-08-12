import { useEffect, useRef, useState } from 'react'
import { type Segment, cutCost, snapToKeyframe } from './segments'

// Canvas rather than DOM: a two-hour clip at high zoom can carry thousands of
// keyframe ticks, and one node each would make panning crawl. One canvas redraws
// in a frame regardless of density.

type View = { start: number; end: number }

const fmt = (t: number, ms = false) => {
  if (!isFinite(t) || t < 0) t = 0
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const p = (n: number) => String(n).padStart(2, '0')
  const base = h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
  return ms ? `${base}.${String(Math.round((t - Math.floor(t)) * 1000)).padStart(3, '0')}` : base
}

/** Ruler step that keeps labels roughly 90px apart at the current zoom. */
function niceStep(spanSeconds: number, widthPx: number) {
  const target = (spanSeconds / widthPx) * 90
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  return steps.find((s) => s >= target) ?? 7200
}

export default function Timeline({
  duration, current, segs, keyframes, fps,
  onSeek, onMoveBoundary, onSelectSegment, selectedId,
}: {
  duration: number
  current: number
  segs: Segment[]
  keyframes: number[]
  fps: number
  onSeek: (t: number) => void
  onMoveBoundary: (index: number, t: number, commit: boolean) => void
  onSelectSegment: (id: number) => void
  selectedId: number | null
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<View>({ start: 0, end: 0 })
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null)
  const drag = useRef<{ kind: 'boundary' | 'scrub'; index: number } | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // Fit the whole clip when it changes.
  useEffect(() => { setView({ start: 0, end: duration || 0 }) }, [duration])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const span = Math.max(0.001, view.end - view.start)
  const toX = (t: number) => ((t - view.start) / span) * size.w
  const toT = (x: number) => view.start + (x / Math.max(1, size.w)) * span

  // ---------------------------------------------------------------- draw
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !size.w || !duration) return
    const dpr = window.devicePixelRatio || 1
    c.width = size.w * dpr
    c.height = size.h * dpr
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, size.w, size.h)

    const RULER = 18
    const trackY = RULER + 4
    const trackH = size.h - trackY - 4

    // ruler
    g.fillStyle = 'rgba(255,255,255,0.03)'
    g.fillRect(0, 0, size.w, RULER)
    const step = niceStep(span, size.w)
    g.strokeStyle = 'rgba(255,255,255,0.15)'
    g.fillStyle = 'rgba(255,255,255,0.45)'
    g.font = '10px ui-monospace, monospace'
    g.beginPath()
    for (let t = Math.ceil(view.start / step) * step; t <= view.end; t += step) {
      const x = Math.round(toX(t)) + 0.5
      g.moveTo(x, RULER - 5); g.lineTo(x, RULER)
      g.fillText(fmt(t), x + 3, 11)
    }
    g.stroke()

    // keyframe ticks - only what is visible, and only if they are not so dense
    // that the track becomes a solid block
    const visible = keyframes.filter((t) => t >= view.start && t <= view.end)
    if (visible.length && visible.length < size.w / 2) {
      g.strokeStyle = 'rgba(56,189,248,0.35)'
      g.beginPath()
      for (const t of visible) {
        const x = Math.round(toX(t)) + 0.5
        g.moveTo(x, trackY); g.lineTo(x, trackY + trackH)
      }
      g.stroke()
    }

    // segments
    for (const s of segs) {
      const x0 = Math.max(-2, toX(s.start))
      const x1 = Math.min(size.w + 2, toX(s.end))
      if (x1 < 0 || x0 > size.w) continue
      const w = Math.max(1, x1 - x0)

      if (s.keep) {
        g.fillStyle = s.id === selectedId ? 'rgba(99,102,241,0.55)' : 'rgba(99,102,241,0.32)'
        g.fillRect(x0, trackY, w, trackH)
      } else {
        // hatched = excluded from the export
        g.fillStyle = 'rgba(255,255,255,0.04)'
        g.fillRect(x0, trackY, w, trackH)
        g.save()
        g.beginPath(); g.rect(x0, trackY, w, trackH); g.clip()
        g.strokeStyle = 'rgba(255,255,255,0.16)'
        g.lineWidth = 1
        g.beginPath()
        for (let x = x0 - trackH; x < x1 + trackH; x += 8) {
          g.moveTo(x, trackY + trackH); g.lineTo(x + trackH, trackY)
        }
        g.stroke()
        g.restore()
      }

      g.strokeStyle = s.id === selectedId ? 'rgba(165,180,252,0.9)' : 'rgba(255,255,255,0.18)'
      g.lineWidth = 1
      g.strokeRect(Math.round(x0) + 0.5, trackY + 0.5, Math.round(w) - 1, trackH - 1)
    }

    // cut handles, coloured by what the cut costs
    for (let i = 0; i < segs.length - 1; i++) {
      const t = segs[i].end
      const x = Math.round(toX(t)) + 0.5
      if (x < -4 || x > size.w + 4) continue
      const cost = cutCost(t, keyframes, fps)
      g.strokeStyle = cost.lossless ? 'rgba(52,211,153,0.95)' : 'rgba(251,191,36,0.95)'
      g.lineWidth = 2
      g.beginPath(); g.moveTo(x, trackY - 3); g.lineTo(x, trackY + trackH + 3); g.stroke()
      g.fillStyle = cost.lossless ? 'rgb(52,211,153)' : 'rgb(251,191,36)'
      g.fillRect(x - 3, trackY - 6, 6, 5)
    }

    // playhead
    const px = Math.round(toX(current)) + 0.5
    if (px >= -2 && px <= size.w + 2) {
      g.strokeStyle = 'rgb(110,231,183)'
      g.lineWidth = 1
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, size.h); g.stroke()
      g.fillStyle = 'rgb(110,231,183)'
      g.beginPath()
      g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.closePath(); g.fill()
    }
  }, [size, view, segs, keyframes, current, duration, selectedId, fps, span])

  // ---------------------------------------------------------------- input
  const boundaryNear = (x: number) => {
    for (let i = 0; i < segs.length - 1; i++) {
      if (Math.abs(toX(segs[i].end) - x) <= 6) return i
    }
    return -1
  }

  const onDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const i = boundaryNear(x)
    if (i >= 0) {
      drag.current = { kind: 'boundary', index: i }
    } else {
      drag.current = { kind: 'scrub', index: -1 }
      onSeek(Math.max(0, Math.min(duration, toT(x))))
      const seg = segs.find((s) => toT(x) >= s.start && toT(x) < s.end)
      if (seg) onSelectSegment(seg.id)
    }
  }

  const onMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const t = Math.max(0, Math.min(duration, toT(x)))
    setHover({ t, x })
    if (!drag.current) return
    if (drag.current.kind === 'scrub') onSeek(t)
    else {
      // Shift snaps to a keyframe, making the cut free.
      const target = e.shiftKey ? snapToKeyframe(t, keyframes) : t
      onMoveBoundary(drag.current.index, target, false)
    }
  }

  const endDrag = () => {
    if (drag.current?.kind === 'boundary') onMoveBoundary(drag.current.index, NaN, true)
    drag.current = null
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!duration) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const anchor = toT(e.clientX - rect.left)
    const factor = e.deltaY > 0 ? 1.25 : 0.8
    const newSpan = Math.min(duration, Math.max(0.5, span * factor))
    const ratio = (anchor - view.start) / span
    let start = anchor - ratio * newSpan
    let end = start + newSpan
    if (start < 0) { start = 0; end = newSpan }
    if (end > duration) { end = duration; start = Math.max(0, duration - newSpan) }
    setView({ start, end })
  }

  const MIN_SPAN = 2

  const setSpanAround = (newSpan: number) => {
    const centre = current >= view.start && current <= view.end ? current : (view.start + view.end) / 2
    const s = Math.min(duration, Math.max(MIN_SPAN, newSpan))
    let start = centre - s / 2
    let end = start + s
    if (start < 0) { start = 0; end = s }
    if (end > duration) { end = duration; start = Math.max(0, duration - s) }
    setView({ start, end })
  }

  const zoom = (factor: number) => setSpanAround(span * factor)

  // Scale slider, matching the reference UI. Logarithmic: 0 shows the whole
  // clip, 100 shows a couple of seconds. Linear would spend most of its travel
  // in a zoom range nobody uses.
  const scalePos = duration > MIN_SPAN
    ? Math.round((Math.log(duration / span) / Math.log(duration / MIN_SPAN)) * 100)
    : 0
  const onScale = (v: number) => {
    if (duration <= MIN_SPAN) return
    setSpanAround(duration * Math.pow(MIN_SPAN / duration, v / 100))
  }

  const hoverCost = hover ? cutCost(hover.t, keyframes, fps) : null

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-2 pb-1 text-[11px] text-white/40">
        <button onClick={() => zoom(0.5)} title="Zoom in (or scroll on the timeline)"
          className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">+</button>
        <button onClick={() => zoom(2)} title="Zoom out"
          className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">−</button>
        <button onClick={() => setView({ start: 0, end: duration })} title="Fit the whole clip"
          className="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20">fit</button>
        <span className="ml-1 text-white/30">scale</span>
        <input
          type="range" min={0} max={100} value={scalePos}
          onChange={(e) => onScale(Number(e.target.value))}
          title="Zoom the timeline"
          className="h-1 w-28 cursor-pointer accent-indigo-400"
        />
        <span className="ml-1 font-mono">{fmt(view.start)} – {fmt(view.end)}</span>
        <div className="flex-1" />
        {hover && (
          <span className="font-mono">
            {fmt(hover.t, true)}
            {hoverCost && keyframes.length > 0 && (
              <span className={hoverCost.lossless ? ' text-emerald-300' : ' text-amber-300'}>
                {' '}· {hoverCost.lossless ? 'on keyframe' : `${hoverCost.reencode.toFixed(2)}s re-encode`}
              </span>
            )}
          </span>
        )}
      </div>

      <div ref={wrapRef} className="relative h-16 w-full px-2">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%' }}
          className="cursor-crosshair rounded bg-black/30"
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={endDrag}
          onMouseLeave={() => { endDrag(); setHover(null) }}
          onWheel={onWheel}
        />
      </div>
      <div className="px-2 pt-1 text-[10px] text-white/25">
        scroll to zoom · drag a cut handle to move it · hold Shift while dragging to snap to a keyframe
      </div>
    </div>
  )
}
