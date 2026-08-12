import { type Segment, cutCost, keptDuration } from './segments'

const tc = (t: number) => {
  if (!isFinite(t) || t < 0) t = 0
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(h)}:${p(m)}:${p(s)}`
}

export default function SegmentList({
  segs, duration, keyframes, fps, selectedId,
  onSelect, onToggle, onSeek, onMerge,
}: {
  segs: Segment[]
  duration: number
  keyframes: number[]
  fps: number
  selectedId: number | null
  onSelect: (id: number) => void
  onToggle: (id: number) => void
  onSeek: (t: number) => void
  onMerge: (index: number) => void
}) {
  const kept = keptDuration(segs)
  const keptCount = segs.filter((s) => s.keep).length

  // What the export will actually cost: every interior boundary that is not on
  // a keyframe has to be rebuilt.
  const cuts = segs.slice(0, -1).map((s) => cutCost(s.end, keyframes, fps))
  const reencode = cuts.reduce((n, c) => n + c.reencode, 0)
  const lossless = cuts.length > 0 && cuts.every((c) => c.lossless)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 overflow-hidden px-2 py-1 text-[11px] text-white/50">
        <span className="shrink-0 font-medium text-white/70">Segments</span>
        <span className="shrink-0">{keptCount}/{segs.length}</span>
        <div className="flex-1" />
        <span className="shrink-0 truncate font-mono">{tc(kept)}</span>
      </div>

      {/* Vertical scroll only. A horizontal scrollbar in a narrow side panel is
          always a layout bug, never a feature - rows must fit whatever width
          the split is dragged to. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2">
        {segs.map((s, i) => {
          const cost = i < segs.length - 1 ? cuts[i] : null
          return (
            <div key={s.id}>
              <div
                onClick={() => { onSelect(s.id); onSeek(s.start) }}
                className={`flex cursor-pointer items-center gap-1.5 overflow-hidden rounded border px-1.5 py-1 text-[11px] ${
                  s.id === selectedId ? 'border-indigo-400/60 bg-indigo-500/15' : 'border-white/10 hover:bg-white/5'
                } ${s.keep ? '' : 'opacity-45'}`}
              >
                <span className={`shrink-0 tabular-nums ${s.keep ? 'text-white/60' : 'text-white/40 line-through'}`}>
                  {i + 1}
                </span>
                <span className={`min-w-0 flex-1 truncate font-mono ${s.keep ? 'text-white/80' : 'text-white/40 line-through'}`}>
                  {tc(s.start)}–{tc(s.end)}
                </span>
                <span className="shrink-0 font-mono text-white/30">{tc(s.end - s.start)}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onToggle(s.id) }}
                  title={s.keep ? 'Exclude this segment from the export' : 'Include it again'}
                  className={`shrink-0 rounded px-1.5 ${
                    s.keep ? 'bg-white/10 hover:bg-red-500/40' : 'bg-emerald-500/25 hover:bg-emerald-500/40'
                  }`}
                >
                  {s.keep ? '🗑' : '↺'}
                </button>
              </div>

              {/* the cut between this segment and the next */}
              {cost && (
                <div className="flex items-center gap-1.5 overflow-hidden py-0.5 pl-2 text-[10px]">
                  <button onClick={() => onSeek(s.end)}
                    title="Jump to this cut"
                    className="shrink-0 font-mono text-white/40 underline-offset-2 hover:text-white hover:underline">
                    ✂{tc(s.end)}
                  </button>
                  <span className={`min-w-0 flex-1 truncate ${cost.lossless ? 'text-emerald-300/80' : 'text-amber-300/80'}`}>
                    {cost.lossless ? 'lossless' : `−${cost.reencode.toFixed(2)}s`}
                  </span>
                  <button onClick={() => onMerge(i)} title="Remove this cut and merge the two segments"
                    className="shrink-0 rounded px-1 text-white/25 hover:bg-white/10 hover:text-white/70">
                    ✕
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {!segs.length && (
          <div className="p-4 text-center text-xs text-white/30">
            Load a clip into the editor to start cutting.
          </div>
        )}
      </div>

      {segs.length > 1 && (
        <div className="shrink-0 border-t border-white/10 px-2 py-1.5 text-[10px] leading-snug">
          {lossless ? (
            <span className="text-emerald-300">All cuts lossless — pure stream copy.</span>
          ) : (
            <>
              <span className="text-white/40">Re-encodes </span>
              <span className="text-white/75">{reencode.toFixed(1)}s</span>
              <span className="text-white/40">
                {' '}of {tc(kept)} ({kept > 0 ? ((reencode / kept) * 100).toFixed(1) : '0'}%)
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
