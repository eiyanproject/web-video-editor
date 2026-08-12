import { useEffect, useRef } from 'react'
import { fmtTimecode } from '../lib/shared'

/**
 * The timecode picker: alarm-clock wheels for hh : mm : ss : ff.
 *
 * It exists because focusing a text timecode field on a phone summons the OS
 * keyboard, which covers the video you are trying to cut - and that keyboard
 * has no notion of a frame anyway.
 *
 * The last column counts frames rather than milliseconds. Milliseconds were
 * tried first and were miserable: a thousand stops is 32000px of scrolling, and
 * almost all of them are positions no cut can land on. Frames are the real
 * resolution - one flick end to end, every stop reachable.
 */

const ITEM = 32          // px per row
const VISIBLE = 3        // rows on screen; 96px total, deliberately small

function Wheel({
  value, max, onChange, label, width = 'w-14', pad = 2,
}: {
  value: number; max: number; onChange: (v: number) => void
  label: string; width?: string; pad?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const settle = useRef<number | null>(null)
  // True between the first scroll event and the moment it settles. Without it
  // the effect below fights the finger: every value change would yank the wheel
  // back to where the parent thinks it is, mid-flick.
  const scrolling = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el || scrolling.current) return
    const top = value * ITEM
    if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top
  }, [value])

  const onScroll = () => {
    scrolling.current = true
    if (settle.current) clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      scrolling.current = false
      const el = ref.current
      if (!el) return
      const i = Math.max(0, Math.min(max, Math.round(el.scrollTop / ITEM)))
      if (i !== value) onChange(i)
    }, 130)
  }

  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        {/* the selected row, drawn behind the numbers */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 rounded bg-white/10"
          style={{ height: ITEM }} />
        <div
          ref={ref}
          onScroll={onScroll}
          className={`no-scrollbar snap-y snap-mandatory overflow-y-scroll overscroll-contain ${width}`}
          style={{ height: ITEM * VISIBLE }}
        >
          {/* one row of padding each end, so the first and last value can sit
              in the middle slot like every other one */}
          <div style={{ height: ITEM }} />
          {Array.from({ length: max + 1 }, (_, i) => (
            <div key={i}
              className={`flex snap-center items-center justify-center font-mono text-base tabular-nums transition-colors ${
                i === value ? 'text-white' : 'text-white/30'
              }`}
              style={{ height: ITEM }}
            >
              {String(i).padStart(pad, '0')}
            </div>
          ))}
          <div style={{ height: ITEM }} />
        </div>
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-white/30">{label}</div>
    </div>
  )
}

export default function TimeWheel({
  time, duration, fps, onChange, onSnapKeyframe,
}: {
  time: number
  duration: number
  fps: number
  onChange: (t: number) => void
  onSnapKeyframe?: () => void
}) {
  const clamp = (t: number) => Math.max(0, Math.min(duration || t, t))

  const h = Math.floor(time / 3600)
  const m = Math.floor((time % 3600) / 60)
  const s = Math.floor(time % 60)

  // The sub-second column counts FRAMES, not milliseconds.
  //
  // A milliseconds wheel is a thousand stops - 32000px end to end - and most of
  // them are positions no cut can land on anyway. Frames are the real
  // resolution of the job: 25 or 30 stops, one flick end to end, and every stop
  // is somewhere a cut can actually go. This is also what broadcast timecode
  // has always been, hh:mm:ss:ff.
  const rate = fps || 25
  const maxF = Math.max(0, Math.ceil(rate) - 1)
  // NEAREST frame, not the one we are inside. Setting frame 7 puts the video at
  // 7/30 = 0.23333, which it reports back as 0.2333 - and flooring that lands
  // on 6, so the wheel visibly jumped back a frame the moment you let go.
  const frameOf = (t: number) =>
    Math.min(maxF, Math.max(0, Math.round((t - Math.floor(t)) * rate)))
  const f = frameOf(time)

  const maxH = Math.max(0, Math.floor((duration || 0) / 3600))

  // Each wheel changes ONE field and reads the other three from the latest
  // time, not from the render it was drawn in. A wheel settles ~130ms after the
  // finger leaves it, and moving two in quick succession made the second
  // compose its new time from the parts it saw before the first landed - so
  // setting seconds and then frames threw the seconds away.
  const timeRef = useRef(time)
  timeRef.current = time

  const set = (part: 'h' | 'm' | 's' | 'f', v: number) => {
    const t = timeRef.current
    const ch = Math.floor(t / 3600)
    const cm = Math.floor((t % 3600) / 60)
    const cs = Math.floor(t % 60)
    const cf = frameOf(t)
    onChange(clamp(
      (part === 'h' ? v : ch) * 3600 +
      (part === 'm' ? v : cm) * 60 +
      (part === 's' ? v : cs) +
      (part === 'f' ? v : cf) / rate,
    ))
  }

  const frame = 1 / rate

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
      <div className="flex items-start justify-center gap-1">
        <Wheel label="hh" value={Math.min(h, maxH)} max={maxH} onChange={(v) => set('h', v)} />
        <div className="pt-3 font-mono text-white/25">:</div>
        <Wheel label="mm" value={m} max={59} onChange={(v) => set('m', v)} />
        <div className="pt-3 font-mono text-white/25">:</div>
        <Wheel label="ss" value={s} max={59} onChange={(v) => set('s', v)} />
        <div className="pt-3 font-mono text-white/25">:</div>
        <Wheel label="ff" value={f} max={maxF} onChange={(v) => set('f', v)} />
      </div>

      {/* The exact time, in full. The frame wheel is the control; this is so
          nothing about where the playhead actually sits is hidden by it. */}
      <div className="mt-1 text-center font-mono text-xs tabular-nums text-white/40">
        {fmtTimecode(time)} · frame {Math.round(time * rate)} @ {rate.toFixed(rate % 1 ? 3 : 0)}fps
      </div>

      <div className="mt-2 flex items-center justify-center gap-2">
        <button
          onClick={() => onChange(clamp(time - frame))}
          className="min-h-[44px] flex-1 rounded-lg bg-white/10 text-sm active:scale-[0.97]"
        >
          −1 frame
        </button>
        <button
          onClick={() => onChange(clamp(time + frame))}
          className="min-h-[44px] flex-1 rounded-lg bg-white/10 text-sm active:scale-[0.97]"
        >
          +1 frame
        </button>
      </div>

      {onSnapKeyframe && (
        <button
          onClick={onSnapKeyframe}
          className="mt-2 min-h-[44px] w-full rounded-lg bg-white/10 text-sm text-white/80 active:scale-[0.97]"
        >
          ⌖ Nearest keyframe — a cut here is free
        </button>
      )}
    </div>
  )
}
