import { useRef } from 'react'
import { fmtTimecode } from '../lib/shared'

/**
 * Drag-to-scrub bar for touch.
 *
 * Pointer Events rather than touch or mouse handlers: one code path covers
 * finger, stylus and mouse, and pointer capture means a drag that wanders off
 * the bar keeps scrubbing instead of stopping dead at the edge - which is most
 * drags, on a bar this short.
 *
 * `touch-none` is what actually makes it work on a phone. Without it the
 * browser claims the gesture for page scrolling before the first pointermove
 * ever arrives, and the bar looks broken rather than slow.
 */
export default function ScrubPad({
  current, duration, onSeek, onScrubStart, onScrubEnd,
}: {
  current: number
  duration: number
  onSeek: (t: number) => void
  onScrubStart?: () => void
  onScrubEnd?: () => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const timeAt = (clientX: number) => {
    const el = trackRef.current
    // A zero-width bar makes the ratio 0/0 = NaN, which propagates through the
    // multiply and throws when it reaches currentTime. It happens whenever the
    // bar is laid out at zero width - a collapsed pane, a hidden tab, the
    // frame before the first measure - so guard the divisor, not the caller.
    if (!el || !duration || !isFinite(duration)) return 0
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return 0
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration
  }

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return
    dragging.current = true
    // Capture is an optimisation, not a requirement: without it a drag that
    // leaves the bar stops early. Never let it take the seek down with it.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* no capture */ }
    onScrubStart?.()
    onSeek(timeAt(e.clientX))
  }

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    onSeek(timeAt(e.clientX))
  }

  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
    onScrubEnd?.()
  }

  const pct = duration ? (current / duration) * 100 : 0

  return (
    <div className="px-3 py-2">
      <div
        ref={trackRef}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className="relative h-11 touch-none select-none overflow-hidden rounded-lg bg-white/10"
      >

        {/* played portion */}
        <div className="pointer-events-none absolute inset-y-0 left-0 bg-indigo-500/25"
          style={{ width: `${pct}%` }} />

        {/* playhead: 2px of ink, but the whole bar is the target */}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-indigo-300"
          style={{ left: `${pct}%` }} />
      </div>

      <div className="mt-1 flex justify-between font-mono text-[11px] tabular-nums text-white/40">
        <span>{fmtTimecode(current).slice(0, 8)}</span>
        <span>{fmtTimecode(duration).slice(0, 8)}</span>
      </div>
    </div>
  )
}
