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
}: {
  path: string
  duration: number
  current: number
  keyframes: number[]
  sprites: SpriteIndex | null
  onSeek: (t: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
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

  const timeAt = (clientX: number) => {
    const el = trackRef.current
    if (!el || !duration) return 0
    const r = el.getBoundingClientRect()
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

  // A two-hour film can carry thousands of keyframes; drawing every one turns
  // the bar into a solid block and costs a DOM node each. Sample to taste.
  const ticks = (() => {
    if (!duration || !keyframes.length || !width) return []
    const maxTicks = Math.min(600, Math.floor(width / 3))
    const step = Math.max(1, Math.ceil(keyframes.length / maxTicks))
    return keyframes.filter((_, i) => i % step === 0)
  })()

  const nearestKf = hoverT != null && keyframes.length
    ? keyframes.reduce((a, b) => (Math.abs(b - hoverT) < Math.abs(a - hoverT) ? b : a))
    : null

  return (
    <div className="select-none px-3 py-2">
      <div
        ref={trackRef}
        onMouseMove={(e) => { setHoverT(timeAt(e.clientX)); setHoverX(e.clientX) }}
        onMouseLeave={() => setHoverT(null)}
        onClick={(e) => onSeek(timeAt(e.clientX))}
        className="relative h-16 cursor-pointer rounded bg-white/10"
      >
        {/* keyframe ticks: where a lossless cut may land. Full height, because
            without thumbnails this bar's job is showing cut geometry. */}
        {ticks.map((t, i) => (
          <div key={i} className="absolute inset-y-0 w-px bg-sky-400/30"
            style={{ left: `${(t / duration) * 100}%` }} />
        ))}

        {/* minute markers for orientation */}
        {duration > 0 && Array.from({ length: Math.min(60, Math.floor(duration / 60)) }, (_, i) => (i + 1) * 60)
          .filter((t) => t < duration)
          .map((t) => (
            <div key={`m${t}`} className="absolute bottom-0 h-2 w-px bg-white/25"
              style={{ left: `${(t / duration) * 100}%` }} />
          ))}

        {/* played portion */}
        <div className="absolute inset-y-0 left-0 rounded-l bg-indigo-500/35" style={{ width: `${pct}%` }} />

        {/* playhead */}
        <div className="absolute inset-y-0 w-0.5 bg-emerald-300" style={{ left: `${pct}%` }} />

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
            <div className="px-2 pb-0.5 text-center font-mono text-[10px] text-sky-300/80">
              keyframe {Math.abs(nearestKf - hoverT) < 0.05 ? 'here' : `${(nearestKf - hoverT >= 0 ? '+' : '')}${(nearestKf - hoverT).toFixed(2)}s`}
            </div>
          )}
        </div>
      )}

      <div className="mt-1 flex items-center gap-3 text-[11px] text-white/35">
        <span className="font-mono">{fmt(current)} / {fmt(duration)}</span>
        {!!keyframes.length && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-px bg-sky-400/70" />
            {keyframes.length} keyframes
          </span>
        )}
        {sprites && !sprites.done && !sprites.error && (
          <span className="text-amber-300/70">
            building thumbnails… {sprites.sheets}/{Math.ceil(sprites.count / 100) || '?'} sheets
          </span>
        )}
        {sprites?.error && <span className="text-red-300/80">thumbnails failed</span>}
        {!sprites && (
          <span className="text-white/25">
            hover for time · thumbnails off (reads the whole file — use the Thumbs button)
          </span>
        )}
      </div>
    </div>
  )
}
