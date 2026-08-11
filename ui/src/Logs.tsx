import { useEffect, useRef, useState } from 'react'

type LogEntry = { ts: number; level: string; target: string; message: string }

const LEVEL_STYLE: Record<string, string> = {
  ERROR: 'text-red-300',
  WARN: 'text-amber-300',
  INFO: 'text-sky-300',
  DEBUG: 'text-white/40',
  TRACE: 'text-white/25',
}

const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString(undefined, { hour12: false })

export default function Logs({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [level, setLevel] = useState('')
  const [contains, setContains] = useState('')
  const [live, setLive] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    const q = new URLSearchParams()
    if (level) q.set('level', level)
    if (contains) q.set('contains', contains)
    const d = await (await fetch(`/api/logs?${q}`)).json()
    setEntries(d.entries)
  }

  useEffect(() => { load() }, [level, contains])

  // Polling rather than SSE: this is a diagnostic page someone has open for a
  // minute, not a hot path. A stream would be more plumbing for no real gain.
  useEffect(() => {
    if (!live) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [live, level, contains])

  useEffect(() => {
    if (live) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, live])

  const copyAll = async () => {
    const text = entries.map((e) => `${fmtTime(e.ts)} ${e.level.padEnd(5)} ${e.target} ${e.message}`).join('\n')
    try { await navigator.clipboard.writeText(text); setMsg('Copied to clipboard') }
    catch { setMsg('Clipboard blocked by the browser') }
    setTimeout(() => setMsg(null), 2500)
  }

  const download = () => {
    const text = entries.map((e) => `${new Date(e.ts * 1000).toISOString()} ${e.level} ${e.target} ${e.message}`).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    a.download = `veditor-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.txt`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const clear = async () => {
    await fetch('/api/logs/clear', { method: 'POST' })
    await load()
  }

  const errors = entries.filter((e) => e.level === 'ERROR').length
  const warns = entries.filter((e) => e.level === 'WARN').length

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-2 text-xs">
        <h1 className="mr-2 text-sm font-semibold">Log</h1>

        <select value={level} onChange={(e) => setLevel(e.target.value)}
          className="rounded bg-white/10 px-2 py-1">
          <option value="">All levels</option>
          <option value="DEBUG">Debug and above</option>
          <option value="INFO">Info and above</option>
          <option value="WARN">Warnings and errors</option>
          <option value="ERROR">Errors only</option>
        </select>

        <input value={contains} onChange={(e) => setContains(e.target.value)}
          placeholder="Filter text…"
          className="w-48 rounded bg-white/10 px-2 py-1 outline-none placeholder:text-white/25" />

        <button onClick={() => setLive(!live)} title="Auto-refresh every 2 seconds"
          className={`rounded px-2 py-1 ${live ? 'bg-emerald-500/70' : 'bg-white/10 hover:bg-white/20'}`}>
          {live ? '● Live' : '⏸ Paused'}
        </button>
        <button onClick={load} className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">⟳ Refresh</button>
        <button onClick={copyAll} className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">⧉ Copy</button>
        <button onClick={download} className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">⭳ Download</button>
        <button onClick={clear} className="rounded bg-red-500/20 px-2 py-1 text-red-200 hover:bg-red-500/40">🗑 Clear</button>

        <div className="flex-1" />
        {errors > 0 && <span className="rounded bg-red-500/20 px-2 py-1 text-red-200">{errors} error{errors > 1 ? 's' : ''}</span>}
        {warns > 0 && <span className="rounded bg-amber-500/20 px-2 py-1 text-amber-200">{warns} warning{warns > 1 ? 's' : ''}</span>}
        <span className="text-white/30">{entries.length} lines</span>
        <button onClick={onClose} className="rounded bg-white/10 px-3 py-1 hover:bg-white/20">← Back</button>
      </div>

      {msg && <div className="bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-100">{msg}</div>}

      <div className="min-h-0 flex-1 overflow-auto bg-black/30 p-2 font-mono text-xs leading-relaxed">
        {entries.map((e, i) => (
          <div key={i} className="flex gap-2 border-b border-white/[0.04] py-0.5 hover:bg-white/5">
            <span className="shrink-0 text-white/30">{fmtTime(e.ts)}</span>
            <span className={`w-12 shrink-0 ${LEVEL_STYLE[e.level] ?? 'text-white/50'}`}>{e.level}</span>
            <span className="shrink-0 text-white/25">{e.target.replace('veditor_api', 'app')}</span>
            <span className="flex-1 whitespace-pre-wrap break-words text-white/80">{e.message}</span>
          </div>
        ))}
        {!entries.length && (
          <div className="p-6 text-center text-white/30">
            Nothing logged yet{level || contains ? ' matching this filter' : ''}.
            <div className="mt-1 text-xs text-white/20">
              Mount attempts, saves, path checks and errors all appear here.
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
