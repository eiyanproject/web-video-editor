import { useEffect, useRef, useState } from 'react'

// Hover-scrub timeline: the K-Lite / MPC behaviour. Hovering shows the frame at
// that moment plus its timestamp, backed by pre-generated sprite sheets, so the
// preview is pure CSS and costs the server nothing after load.

export type SpriteIndex = {
  interval: number
  tile_w: number
  tile_h: number
  cols: number
  rows: number
  sheets: number
  count: number
  done: boolean
  error: string
}

const fmt = (t: number) => {
  if (!isFinite(t) || t < 0) t = 0
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}

export default function Scrubber({
  path, duration, current, keyframes, sprites, onSeek,
  indexing = false, loadedForEditing = false, peaks,
}: {
  path: string
  duration: number
  current: number
  keyframes: number[]
  sprites: SpriteIndex | null
  onSeek: (t: number) => void
  indexing?: boolean
  loadedForEditing?: boolean
  /// Peak envelope, 0..1 per bucket. Undefined until generated on request.
  peaks?: number[]
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const waveRef = useRef<HTMLCanvasElement>(null)
  const [hoverT, setHoverT] = useState<number | null>(null)
  const [hoverX, setHoverX] = useState(0)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Drawn on a canvas rather than 1800 DOM nodes: it is a picture, and it has
  // to redraw on every resize.
  useEffect(() => {
    const c = waveRef.current
    if (!c || !peaks?.length || !width) return
    const dpr = window.devicePixelRatio || 1
    const h = c.clientHeight || 40
    c.width = width * dpr
    c.height = h * dpr
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, h)
    g.fillStyle = 'rgba(255,255,255,0.28)'
    const mid = h / 2
    const step = width / peaks.length
    for (let i = 0; i < peaks.length; i++) {
      const a = Math.min(1, peaks[i] * 1.6) * (h / 2 - 1)
      g.fillRect(i * step, mid - a, Math.max(1, step), a * 2)
    }
  }, [peaks, width])

  const timeAt = (clientX: number) => {
    const el = trackRef.current
    // A zero-width bar makes the ratio 0/0 = NaN, which propagates through the
    // multiply and throws when it reaches currentTime. It happens whenever the
    // bar is laid out at zero width - a collapsed pane, a hidden tab, the
    // frame before the first measure - so guard the divisor, not the caller.
    if (!el || !duration || !isFinite(duration)) return 0
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return ratio * duration
  }

  // Which tile of which sheet covers time t. ffmpeg numbers sheets from 1.
  const tileFor = (t: number) => {
    if (!sprites || !sprites.interval) return null
    const per = sprites.cols * sprites.rows
    const i = Math.min(sprites.count - 1, Math.floor(t / sprites.interval))
    if (i < 0) return null
    const sheet = Math.floor(i / per) + 1
    if (sheet > sprites.sheets) return null
    const pos = i % per
    return {
      url: `/api/sprites/sheet?path=${encodeURIComponent(path)}&n=${sheet}`,
      x: -(pos % sprites.cols) * sprites.tile_w,
      y: -Math.floor(pos / sprites.cols) * sprites.tile_h,
      w: sprites.tile_w,
      h: sprites.tile_h,
      sheetW: sprites.cols * sprites.tile_w,
      sheetH: sprites.rows * sprites.tile_h,
    }
  }

  const tile = hoverT != null ? tileFor(hoverT) : null
  const pct = duration ? (current / duration) * 100 : 0

  const nearestKf = hoverT != null && keyframes.length
    ? keyframes.reduce((a, b) => (Math.abs(b - hoverT) < Math.abs(a - hoverT) ? b : a))
    : null

  return (
    <div className="select-none px-3 py-1.5">
      <div
        ref={trackRef}
        onMouseMove={(e) => { setHoverT(timeAt(e.clientX)); setHoverX(e.clientX) }}
        onMouseLeave={() => setHoverT(null)}
        onClick={(e) => onSeek(timeAt(e.clientX))}
        className="relative h-7 cursor-pointer overflow-hidden rounded-lg bg-white/[0.07]"
      >
        {/* Audio envelope: silence and scene changes are visible at a glance. */}
        {!!peaks?.length && (
          <canvas ref={waveRef} className="pointer-events-none absolute inset-0 h-full w-full" />
        )}

        {/* minute markers for orientation */}
        {duration > 0 && Array.from({ length: Math.min(60, Math.floor(duration / 60)) }, (_, i) => (i + 1) * 60)
          .filter((t) => t < duration)
          .map((t) => (
            <div key={`m${t}`} className="absolute bottom-0 h-2 w-px bg-white/25"
              style={{ left: `${(t / duration) * 100}%` }} />
          ))}

        {/* played portion */}
        <div className="absolute inset-y-0 left-0 rounded-l bg-indigo-500/25" style={{ width: `${pct}%` }} />

        {/* playhead */}
        <div className="absolute inset-y-0 w-0.5 bg-indigo-300" style={{ left: `${pct}%` }} />

        {/* hover line */}
        {hoverT != null && duration > 0 && (
          <div className="absolute inset-y-0 w-px bg-white/60"
            style={{ left: `${(hoverT / duration) * 100}%` }} />
        )}
      </div>

      {/* hover preview, positioned against the viewport so it never clips */}
      {hoverT != null && duration > 0 && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded border border-white/20 bg-black/90 p-1 shadow-lg"
          style={{
            left: Math.max(90, Math.min(window.innerWidth - 90, hoverX)),
            top: (trackRef.current?.getBoundingClientRect().top ?? 0) - 6,
          }}
        >
          {/* Thumbnails only appear if they were generated on purpose. */}
          {tile && (
            <div
              className="mb-1"
              style={{
                width: tile.w, height: tile.h,
                backgroundImage: `url(${tile.url})`,
                backgroundPosition: `${tile.x}px ${tile.y}px`,
                backgroundSize: `${tile.sheetW}px ${tile.sheetH}px`,
              }}
            />
          )}
          <div className={`text-center font-mono text-white/90 ${tile ? 'text-[11px]' : 'px-2 py-0.5 text-base'}`}>
            {fmt(hoverT)}
          </div>
          {nearestKf != null && (
            <div className="px-2 pb-0.5 text-center font-mono text-[10px] text-white/60/80">
              keyframe {Math.abs(nearestKf - hoverT) < 0.05 ? 'here' : `${(nearestKf - hoverT >= 0 ? '+' : '')}${(nearestKf - hoverT).toFixed(2)}s`}
            </div>
          )}
        </div>
      )}

      {/* Time on the left, status on the right, and the ADVICE only while the
          pointer is here.
          A row of permanent grey hints is the interface talking to itself: it
          is the same words every time you look, so after a day they are noise
          you have learned to skip, and they still cost the space. Progress -
          indexing, building, failed - is never hidden, because that is a
          changing fact rather than a hint. */}
      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-white/40">
        {/* No clock here. The player's own controls sit directly above this bar
            and already show current / duration to the second; the toolbar chip
            carries the millisecond figure that those cannot. Printing it a
            third time is what made the pane feel repetitive. */}
        <div className="flex-1" />

        {indexing && <span className="text-amber-300">indexing keyframes…</span>}
        {sprites && !sprites.done && !sprites.error && (
          <span className="text-amber-300">
            building thumbnails {sprites.sheets}/{Math.ceil(sprites.count / 100) || '?'}
          </span>
        )}
        {sprites?.error && <span className="text-red-300">thumbnails failed</span>}

        {/* opacity, not conditional rendering: the row must not change height
            or reflow when the pointer arrives. */}
        <span className={`transition-opacity duration-150 ${hoverT != null ? 'opacity-100' : 'opacity-0'}`}>
          {!!keyframes.length && <span className="text-white/35">{keyframes.length} keyframes · </span>}
          <span className="text-white/30">
            {sprites ? 'drag to scrub' : 'thumbnails off — Player actions ▸ Build thumbnails'}
          </span>
        </span>
      </div>
    </div>
  )
}
