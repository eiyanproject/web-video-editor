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
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-white/50">
        <span className="font-medium text-white/70">Segments</span>
        <span>{keptCount} of {segs.length} kept</span>
        <div className="flex-1" />
        <span className="font-mono">{tc(kept)} / {tc(duration)}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {segs.map((s, i) => {
          const cost = i < segs.length - 1 ? cuts[i] : null
          return (
            <div key={s.id}>
              <div
                onClick={() => { onSelect(s.id); onSeek(s.start) }}
                className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-xs ${
                  s.id === selectedId ? 'border-indigo-400/60 bg-indigo-500/15' : 'border-white/10 hover:bg-white/5'
                } ${s.keep ? '' : 'opacity-45'}`}
              >
                <span className={`w-14 shrink-0 ${s.keep ? 'text-white/70' : 'text-white/40 line-through'}`}>
                  Seg {i + 1}
                </span>
                <span className={`flex-1 font-mono ${s.keep ? 'text-white/80' : 'text-white/40 line-through'}`}>
                  {tc(s.start)} – {tc(s.end)}
                </span>
                <span className="w-14 shrink-0 text-right font-mono text-white/35">
                  {tc(s.end - s.start)}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onToggle(s.id) }}
                  title={s.keep ? 'Exclude this segment from the export' : 'Include it again'}
                  className={`shrink-0 rounded px-2 py-0.5 ${
                    s.keep ? 'bg-white/10 hover:bg-red-500/40' : 'bg-emerald-500/25 hover:bg-emerald-500/40'
                  }`}
                >
                  {s.keep ? '🗑' : '↺'}
                </button>
              </div>

              {/* the cut between this segment and the next */}
              {cost && (
                <div className="flex items-center gap-2 py-0.5 pl-4 text-[10px]">
                  <span className="text-white/20">├ cut at</span>
                  <button onClick={() => onSeek(s.end)}
                    className="font-mono text-white/45 underline-offset-2 hover:text-white hover:underline">
                    {tc(s.end)}
                  </button>
                  <span className={cost.lossless ? 'text-emerald-300/80' : 'text-amber-300/80'}>
                    {cost.lossless ? 'lossless' : `exact · re-encodes ${cost.reencode.toFixed(2)}s`}
                  </span>
                  <button onClick={() => onMerge(i)} title="Remove this cut and merge the two segments"
                    className="ml-auto rounded px-1.5 text-white/30 hover:bg-white/10 hover:text-white/70">
                    remove cut
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
        <div className="border-t border-white/10 px-3 py-2 text-[11px]">
          <span className="text-white/40">Export will </span>
          {lossless ? (
            <span className="text-emerald-300">stream-copy everything — no re-encoding at all.</span>
          ) : (
            <>
              <span className="text-white/70">re-encode {reencode.toFixed(1)}s</span>
              <span className="text-white/40">
                {' '}of {tc(kept)} ({kept > 0 ? ((reencode / kept) * 100).toFixed(1) : '0'}%), copying the rest.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
