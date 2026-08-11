import { useState } from 'react'

export type Finding = { level: string; message: string }
export type Probe = {
  path: string; size: number; container: string; duration: number; bit_rate: number
  video_codec: string; profile: string; level: number; width: number; height: number
  pix_fmt: string; fps: number; avg_fps: number; vfr: boolean; field_order: string
  sar: string; color_space: string
  audio: { index: number; codec: string; channels: number; sample_rate: string; language: string; browser_playable: boolean }[]
  smartcut_ok: boolean; browser_playable: boolean; findings: Finding[]
}

const fmtSize = (n: number) => {
  if (!n) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}
const fmtDur = (t: number) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60)
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`
}

const TONE: Record<string, string> = {
  error: 'border-red-400 bg-red-500/15 text-red-100',
  warn: 'border-amber-400 bg-amber-500/15 text-amber-100',
  info: 'border-sky-400 bg-sky-500/10 text-sky-100',
}

export default function MediaInfo({
  probe, keyframeCount, avgGap, onDeepCheck, deep, busy,
}: {
  probe: Probe
  keyframeCount: number
  avgGap: number
  onDeepCheck: () => void
  deep: { ok: boolean; errors: string[]; took_ms: number } | null
  busy: boolean
}) {
  const [open, setOpen] = useState(false)

  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="text-white/35">{k}</span>
      <span className="truncate text-right text-white/75">{v}</span>
    </div>
  )

  return (
    <div className="border-t border-white/10 text-xs">
      <button onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/5">
        <span className="text-white/40">{open ? '▾' : '▸'}</span>
        <span className="font-medium text-white/70">Media info</span>
        <span className="text-white/40">
          {probe.width}×{probe.height} · {probe.video_codec.toUpperCase()} · {probe.fps.toFixed(3)} fps · {fmtDur(probe.duration)}
        </span>
        <div className="flex-1" />
        {/* The two verdicts that actually matter, always visible. */}
        <span className={`rounded px-1.5 py-0.5 ${probe.smartcut_ok ? 'bg-emerald-500/25 text-emerald-200' : 'bg-amber-500/25 text-amber-200'}`}>
          {probe.smartcut_ok ? 'frame-exact cuts' : 'keyframe-snap only'}
        </span>
        <span className={`rounded px-1.5 py-0.5 ${probe.browser_playable ? 'bg-emerald-500/25 text-emerald-200' : 'bg-white/10 text-white/50'}`}>
          {probe.browser_playable ? 'plays in browser' : 'preview unsupported'}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3">
          {probe.findings.map((f, i) => (
            <div key={i} className={`mb-1.5 rounded border-l-2 px-2 py-1.5 ${TONE[f.level] ?? TONE.info}`}>
              {f.message}
            </div>
          ))}

          <div className="grid gap-x-6 sm:grid-cols-2">
            <div>
              <Row k="Container" v={probe.container.split(',')[0]} />
              <Row k="Size" v={fmtSize(probe.size)} />
              <Row k="Duration" v={fmtDur(probe.duration)} />
              <Row k="Bitrate" v={probe.bit_rate ? `${(probe.bit_rate / 1000).toFixed(0)} kbps` : '—'} />
              <Row k="Codec" v={`${probe.video_codec} ${probe.profile}${probe.level ? ` @L${(probe.level / 10).toFixed(1)}` : ''}`} />
              <Row k="Pixel format" v={probe.pix_fmt || '—'} />
            </div>
            <div>
              <Row k="Frame rate" v={probe.vfr ? `${probe.fps.toFixed(3)} (variable)` : `${probe.fps.toFixed(3)} constant`} />
              <Row k="Scan" v={probe.field_order || 'progressive'} />
              <Row k="Aspect (SAR)" v={probe.sar || '1:1'} />
              <Row k="Keyframes" v={keyframeCount ? `${keyframeCount} · every ${avgGap.toFixed(1)}s` : 'not indexed'} />
              <Row k="Audio" v={probe.audio.length
                ? probe.audio.map((a) => `${a.codec} ${a.channels}ch`).join(', ')
                : 'none'} />
              <Row k="Frame count" v={probe.fps ? Math.round(probe.duration * probe.fps).toLocaleString() : '—'} />
            </div>
          </div>

          {/* The number that decides whether smart-cut is worth it for this file. */}
          {keyframeCount > 0 && (
            <div className="mt-2 rounded bg-white/[0.04] px-2 py-1.5 text-white/50">
              A keyframe-snap cut on this file could land up to{' '}
              <b className="text-white/80">{avgGap.toFixed(1)}s</b> from where you click.
              {probe.smartcut_ok
                ? ' Smart-cut removes that by re-encoding only the boundary GOP.'
                : ' Smart-cut is unavailable for this file, so that error is unavoidable.'}
            </div>
          )}

          <div className="mt-2 flex items-center gap-2">
            <button onClick={onDeepCheck} disabled={busy}
              title="Decode the first and last 20 seconds looking for real corruption"
              className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-40">
              {busy ? 'Checking…' : '🔍 Deep check'}
            </button>
            {deep && (
              <span className={deep.ok ? 'text-emerald-300' : 'text-red-300'}>
                {deep.ok
                  ? `No decode errors in the first or last 20s (${deep.took_ms} ms)`
                  : `${deep.errors.length} decode problem(s) found`}
              </span>
            )}
          </div>
          {deep && !deep.ok && (
            <div className="mt-1 rounded bg-red-500/15 px-2 py-1.5 font-mono text-[11px] text-red-100">
              {deep.errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
