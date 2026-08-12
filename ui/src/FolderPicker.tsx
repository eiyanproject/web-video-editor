import { useEffect, useState } from 'react'

// A small directory browser for choosing a folder, because knowing the exact
// path of somewhere on a NAS from memory is not reasonable to expect.

type Entry = { name: string; abs: string; is_dir: boolean; problem?: string }

export default function FolderPicker({
  initial, title, onPick, onClose,
}: {
  initial: string
  title: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const [cwd, setCwd] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [manual, setManual] = useState(initial)
  const [newName, setNewName] = useState('')

  const open = async (p: string) => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`/api/browse?path=${encodeURIComponent(p)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setEntries((d.entries ?? []).filter((e: Entry) => e.is_dir))
      setCwd(d.path ?? '')
      setParent(d.parent ?? null)
      if (d.path) setManual(d.path)
    } catch (e: any) {
      setErr(String(e.message ?? e))
      setEntries([])
    } finally { setLoading(false) }
  }

  // Start where the field already points, falling back to the library roots if
  // that folder has gone away.
  useEffect(() => {
    if (!initial.trim()) { open(''); return }
    fetch(`/api/resolve?path=${encodeURIComponent(initial)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => open(d?.is_dir ? d.abs : ''))
      .catch(() => open(''))
  }, [])

  const crumbs = cwd ? cwd.split('/').filter(Boolean) : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}>
      <div className="flex h-[70vh] w-full max-w-2xl flex-col rounded-lg border border-white/15 bg-[#12141a] shadow-xl"
        onClick={(e) => e.stopPropagation()}>

        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-sm">
          <span className="font-medium text-white/80">{title}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="rounded px-2 py-0.5 text-white/40 hover:bg-white/10 hover:text-white">✕</button>
        </div>

        <div className="flex flex-wrap items-center gap-0.5 border-b border-white/10 px-3 py-1.5 text-xs">
          <button onClick={() => open('')} className="rounded px-1 text-white/50 hover:bg-white/10 hover:text-white">
            Library
          </button>
          {crumbs.map((name, i) => {
            const path = '/' + crumbs.slice(0, i + 1).join('/')
            return (
              <span key={path} className="flex items-center gap-0.5">
                <span className="text-white/20">/</span>
                <button onClick={() => open(path)}
                  className="max-w-[14rem] truncate rounded px-1 text-white/60 hover:bg-white/10 hover:text-white">
                  {name}
                </button>
              </span>
            )
          })}
          {loading && <span className="ml-2 text-white/30">loading…</span>}
        </div>

        <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5 text-xs">
          <button onClick={() => parent && open(parent)} disabled={!parent}
            className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-30">↑ Up</button>
          <button onClick={() => open(cwd)} className="rounded bg-white/10 px-2 py-1 hover:bg-white/20">⟳</button>
          <input value={newName}
            onChange={(e) => setNewName(e.target.value.replace(/[\\/:*?"<>|\r\n\t]/g, ''))}
            placeholder="new subfolder name…"
            className="ml-2 w-44 rounded bg-white/10 px-2 py-1 outline-none placeholder:text-white/25" />
          <button
            disabled={!newName.trim() || !cwd}
            title="Creates the folder when you save — the picker only proposes the path"
            onClick={() => { setManual(`${cwd.replace(/\/$/, '')}/${newName.trim()}`); setNewName('') }}
            className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-30">
            + use as new
          </button>
        </div>

        {err && <div className="bg-red-500/20 px-3 py-1.5 text-xs text-red-200">{err}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto text-sm">
          {entries.map((e) => (
            <button key={e.abs} onClick={() => open(e.abs)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5">
              <span className="text-white/40">📁</span>
              <span className="flex-1 truncate">{e.name}</span>
              {e.problem && <span className="text-[10px] text-amber-300/70">{e.problem}</span>}
            </button>
          ))}
          {!entries.length && !loading && (
            <div className="p-4 text-xs text-white/30">
              {cwd ? 'No sub-folders here — you can still choose this folder.' : 'No library folders yet.'}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-white/10 px-3 py-2">
          <input value={manual}
            onChange={(e) => setManual(e.target.value.replace(/[\r\n\t]/g, '').replace(/^\s+/, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter' && manual.trim()) onPick(manual.trim()) }}
            placeholder="or type a path"
            className="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 font-mono text-xs outline-none placeholder:font-sans placeholder:text-white/25" />
          <button onClick={() => manual.trim() && onPick(manual.trim())} disabled={!manual.trim()}
            className="shrink-0 rounded bg-indigo-500 px-3 py-1.5 text-xs font-medium hover:bg-indigo-400 disabled:opacity-40">
            Use this folder
          </button>
        </div>
      </div>
    </div>
  )
}
