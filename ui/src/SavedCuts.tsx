import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icon'
import { fmtDate } from './lib/shared'

// The cut-list library. One row per saved edit, which since 2026-11-24 means
// one row in `config/edits.db` rather than one file on the share.
//
// This exists because the list it replaces was five rows tall and buried in
// Settings beside the log viewer, which is survivable for a handful of cut
// lists and useless for several hundred. Most of them describe films that have
// since been exported and deleted, so the two things that matter at this size
// are **finding one** and **knowing whether its film is still there** - hence
// the search box and the present/missing filter, before anything else.
//
// Everything destructive here goes through one typed confirmation. Deleting a
// cut list is not recoverable from inside the app, and at this scale a stray
// click can take hundreds of rows.

type Row = {
  title: string
  source: string
  name: string
  segments: number
  kept: number
  kept_seconds: number
  duration: number
  saved_at: number
  exists: boolean
}

type ImportReport = {
  dry_run: boolean
  added: number
  updated: number
  rejected: { name: string; reason: string }[]
}

type Sort = 'saved' | 'name' | 'kept'

/** A browser download from bytes we already hold, so export and database
 *  download share one path and neither needs a GET the server has to
 *  authorise twice. */
const download = (name: string, body: BlobPart, type: string) => {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // Revoked on the next tick rather than immediately: Firefox cancels the
  // download if the URL dies before it has started reading.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const today = () => new Date().toISOString().slice(0, 10)

/** A length, not a timecode to cut against. `fmtTimecode` carries milliseconds
 *  because a frame boundary needs them; down a column of several hundred rows
 *  they are three digits of noise on every line. */
const len = (t: number) => {
  if (!isFinite(t) || t <= 0) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

export default function SavedCuts({
  onClose,
  onOpen,
}: {
  onClose: () => void
  /** Load this film into the editor. The editor fetches its cuts itself, the
   *  same way it does for any clip, so this hands over a path and nothing
   *  else. */
  onOpen: (path: string) => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const [q, setQ] = useState('')
  const [only, setOnly] = useState<'all' | 'present' | 'missing'>('all')
  const [sort, setSort] = useState<Sort>('saved')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  // What the typed confirmation is for, null when it is closed.
  const [confirm, setConfirm] = useState<null | { what: string; count: number; run: () => Promise<void> }>(null)
  const [typed, setTyped] = useState('')

  const [report, setReport] = useState<(ImportReport & { payload: unknown }) | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)

  const load = async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await fetch('/api/edits')
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? r.statusText)
      setRows(d)
    } catch (e: any) {
      setErr(`Could not read the cut lists: ${e.message ?? e}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    search.current?.focus()
  }, [])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = rows.filter((r) => {
      if (only === 'present' && !r.exists) return false
      if (only === 'missing' && r.exists) return false
      if (!needle) return true
      // Path as well as name: the only way to tell two copies of one film
      // apart is the folder they are in.
      return r.name.toLowerCase().includes(needle) || r.source.toLowerCase().includes(needle)
    })
    out.sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : sort === 'kept'
        ? b.kept_seconds - a.kept_seconds
        : b.saved_at - a.saved_at,
    )
    return out
  }, [rows, q, only, sort])

  const missingCount = rows.filter((r) => !r.exists).length
  const selected = shown.filter((r) => picked.has(r.title))
  // Select-all applies to what is on screen, not to the whole database: a
  // filtered list is the question you just asked, and a tick that quietly
  // included 600 hidden rows would be the worst possible place to be generous.
  const allShown = shown.length > 0 && shown.every((r) => picked.has(r.title))

  const toggle = (title: string) =>
    setPicked((p) => {
      const n = new Set(p)
      n.has(title) ? n.delete(title) : n.add(title)
      return n
    })

  const toggleAll = () =>
    setPicked((p) => {
      const n = new Set(p)
      if (allShown) shown.forEach((r) => n.delete(r.title))
      else shown.forEach((r) => n.add(r.title))
      return n
    })

  const say = (m: string) => {
    setNote(m)
    setTimeout(() => setNote((cur) => (cur === m ? null : cur)), 6000)
  }

  // ---------------------------------------------------------------- export

  const exportTitles = async (titles: string[], label: string) => {
    setBusy('export')
    setErr(null)
    try {
      const r = await fetch('/api/edits/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ titles }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? r.statusText)
      const n = d.edits?.length ?? 0
      download(`cut-lists-${label}-${today()}.json`, JSON.stringify(d, null, 2), 'application/json')
      say(`Exported ${n} cut list${n === 1 ? '' : 's'}`)
    } catch (e: any) {
      setErr(`Export failed: ${e.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  const downloadDb = async () => {
    setBusy('db')
    setErr(null)
    try {
      const r = await fetch('/api/edits/db')
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error ?? r.statusText)
      }
      const buf = await r.arrayBuffer()
      download(`edits-${today()}.db`, buf, 'application/vnd.sqlite3')
      say(`Database downloaded — ${(buf.byteLength / 1024).toFixed(0)} KB. Restoring it is copying it back into config/.`)
    } catch (e: any) {
      setErr(`Download failed: ${e.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  // ---------------------------------------------------------------- import

  /** Reads the files, then asks the server to check them WITHOUT writing. The
   *  outcome is shown and has to be applied, because the one thing an import
   *  must never be is a file picker whose effect you learn about afterwards. */
  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy('import')
    setErr(null)
    setReport(null)
    try {
      const parts: unknown[] = []
      for (const f of Array.from(files)) {
        const text = await f.text()
        let parsed: any
        try {
          parsed = JSON.parse(text)
        } catch (e: any) {
          throw new Error(`${f.name} is not valid JSON: ${e.message ?? e}`)
        }
        // A bundle, a bare array, or one old-style .wve.json object - all three
        // flatten into one list, so you can select all 719 loose files at once.
        if (Array.isArray(parsed)) parts.push(...parsed)
        else if (parsed && Array.isArray(parsed.edits)) parts.push(...parsed.edits)
        else parts.push(parsed)
      }
      const r = await fetch('/api/edits/import?dry_run=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parts),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? r.statusText)
      setReport({ ...d, payload: parts })
    } catch (e: any) {
      setErr(`Could not read that: ${e.message ?? e}`)
    } finally {
      setBusy(null)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const applyImport = async () => {
    if (!report) return
    setBusy('import')
    setErr(null)
    try {
      const r = await fetch('/api/edits/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report.payload),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? r.statusText)
      setReport(null)
      await load()
      say(`Imported ${d.added} new and ${d.updated} updated cut list${d.added + d.updated === 1 ? '' : 's'}`)
    } catch (e: any) {
      setErr(`Import failed: ${e.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  // ---------------------------------------------------------------- delete

  const ask = (what: string, count: number, run: () => Promise<void>) => {
    setTyped('')
    setConfirm({ what, count, run })
  }

  const deleteTitles = (titles: string[], what: string) =>
    ask(what, titles.length, async () => {
      const r = await fetch('/api/edits/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ titles }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? r.statusText)
      setPicked(new Set())
      await load()
      say(`Deleted ${d.removed} cut list${d.removed === 1 ? '' : 's'}`)
    })

  const deleteMissing = () =>
    ask(`every cut list whose film is missing`, missingCount, async () => {
      const r = await fetch('/api/edits/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `expect` is the guard: the server stats every row again, and refuses
        // outright if that now finds more than this screen offered.
        body: JSON.stringify({ missing: true, expect: missingCount }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? r.statusText)
      await load()
      say(`Deleted ${d.removed} cut list${d.removed === 1 ? '' : 's'} whose film was gone`)
    })

  const runConfirmed = async () => {
    if (!confirm || typed.trim().toLowerCase() !== 'delete') return
    const run = confirm.run
    setConfirm(null)
    setBusy('delete')
    setErr(null)
    try {
      await run()
    } catch (e: any) {
      setErr(`Delete failed: ${e.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  // ---------------------------------------------------------------- render

  const btn = 'shrink-0 rounded bg-white/10 px-2.5 py-1 hover:bg-white/20 disabled:opacity-30'
  const chip = (on: boolean) =>
    `rounded px-2 py-1 ${on ? 'bg-indigo-500/25 text-indigo-100' : 'bg-white/5 text-white/50 hover:bg-white/10'}`

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-xs">
        <span className="text-sm font-medium text-white/80">Saved cuts</span>
        <span className="text-white/35">
          {rows.length} cut list{rows.length === 1 ? '' : 's'} in the database
          {missingCount ? ` · ${missingCount} whose film is gone` : ''}
        </span>
        {loading && <span className="text-white/25">loading…</span>}
        <div className="flex-1" />
        <button onClick={load} className={btn} title="Re-read the list and re-check which films are still there">
          <Icon name="refresh" />
        </button>
        <button onClick={onClose} className="rounded bg-white/10 px-3 py-1 hover:bg-white/20">← Back</button>
      </div>

      {/* ---------------------------------------------- toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-xs">
        <div className="flex min-w-[14rem] flex-1 items-center gap-2 rounded bg-white/10 px-2 py-1">
          <Icon name="search" />
          <input
            ref={search}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or folder"
            className="w-full bg-transparent outline-none placeholder:text-white/25"
          />
          {!!q && (
            <button onClick={() => setQ('')} className="text-white/40 hover:text-white/80" title="Clear">
              <Icon name="close" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button onClick={() => setOnly('all')} className={chip(only === 'all')}>All</button>
          <button onClick={() => setOnly('present')} className={chip(only === 'present')}>
            Film present
          </button>
          <button onClick={() => setOnly('missing')} className={chip(only === 'missing')}>
            Film gone
          </button>
        </div>

        <label className="flex items-center gap-1 text-white/40">
          sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="rounded bg-white/10 px-1.5 py-1 text-white/80 outline-none">
            <option value="saved">newest</option>
            <option value="name">name</option>
            <option value="kept">most kept</option>
          </select>
        </label>
      </div>

      {/* ---------------------------------------------- data controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-xs">
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          multiple
          onChange={(e) => pickFiles(e.target.files)}
          className="hidden"
        />
        <button onClick={() => fileInput.current?.click()} disabled={!!busy} className={btn}>
          Import JSON…
        </button>
        <button onClick={() => exportTitles([], 'all')} disabled={!!busy || !rows.length} className={btn}>
          <Icon name="download" /> Export all
        </button>
        <button onClick={downloadDb} disabled={!!busy} className={btn}
          title="One file, and restoring it is copying it back into config/">
          <Icon name="download" /> Download database
        </button>
        <div className="flex-1" />
        <button onClick={deleteMissing} disabled={!!busy || !missingCount}
          className="shrink-0 rounded bg-red-500/15 px-2.5 py-1 text-red-200 hover:bg-red-500/30 disabled:opacity-30">
          <Icon name="trash" /> Delete {missingCount} with no film
        </button>
      </div>

      {/* ---------------------------------------------- selection bar */}
      {!!selected.length && (
        <div className="flex flex-wrap items-center gap-2 border-b border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-xs">
          <span className="text-indigo-100">{selected.length} selected</span>
          <button
            onClick={() => exportTitles(selected.map((r) => r.title), 'selected')}
            disabled={!!busy}
            className={btn}>
            <Icon name="download" /> Export selected
          </button>
          <button
            onClick={() =>
              deleteTitles(
                selected.map((r) => r.title),
                `${selected.length} selected cut list${selected.length === 1 ? '' : 's'}`,
              )
            }
            disabled={!!busy}
            className="shrink-0 rounded bg-red-500/15 px-2.5 py-1 text-red-200 hover:bg-red-500/30 disabled:opacity-30">
            <Icon name="trash" /> Delete selected
          </button>
          <button onClick={() => setPicked(new Set())} className="text-indigo-100/60 hover:text-indigo-100">
            clear
          </button>
        </div>
      )}

      {err && (
        <div className="border-b border-red-400/30 bg-red-500/15 px-3 py-2 text-xs text-red-100">{err}</div>
      )}
      {note && !err && (
        <div className="border-b border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
          {note}
        </div>
      )}

      {/* ---------------------------------------------- import report */}
      {report && (
        <div className="border-b border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-50">
          <div className="flex flex-wrap items-center gap-2">
            <b>Checked, nothing written yet.</b>
            <span>
              {report.added} new · {report.updated} would be overwritten · {report.rejected.length} rejected
            </span>
            <div className="flex-1" />
            <button onClick={applyImport} disabled={!!busy || report.added + report.updated === 0}
              className="rounded bg-amber-400/25 px-2.5 py-1 hover:bg-amber-400/40 disabled:opacity-30">
              Import {report.added + report.updated}
            </button>
            <button onClick={() => setReport(null)} className="rounded px-2 py-1 hover:bg-white/10">
              Cancel
            </button>
          </div>
          {!!report.updated && (
            <div className="mt-1 text-amber-100/70">
              Overwriting replaces those cut lists with the ones in the file. Export them first if you
              are not sure.
            </div>
          )}
          {!!report.rejected.length && (
            <div className="mt-2 max-h-28 overflow-y-auto rounded bg-black/20 p-2">
              {report.rejected.map((x, i) => (
                <div key={i} className="truncate">
                  <span className="text-amber-200">{x.name}</span>
                  <span className="text-amber-100/60"> — {x.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------------------------------------------- the table */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Only the first load blanks the table. Every later one keeps the rows
            on screen and lets the header's spinner-free "loading…" do the
            talking: a delete or an import re-reads the list, and a table that
            vanishes for half a second each time reads as having lost
            everything. */}
        {loading && !rows.length ? (
          <div className="p-6 text-center text-xs text-white/30">loading…</div>
        ) : !rows.length ? (
          <div className="p-6 text-center text-xs text-white/35">
            No cut lists yet. They are saved as you edit — one per clip, keyed by its name.
          </div>
        ) : !shown.length ? (
          <div className="p-6 text-center text-xs text-white/35">
            Nothing matches {q ? <>“{q}”</> : 'that filter'}.
          </div>
        ) : (
          <table className="w-full table-fixed text-xs">
            <thead className="sticky top-0 bg-[#141416] text-white/40">
              <tr>
                <th className="w-8 py-1.5">
                  <input type="checkbox" checked={allShown} onChange={toggleAll}
                    title="Select everything currently listed" />
                </th>
                <th className="py-1.5 text-left font-normal">clip</th>
                <th className="w-24 py-1.5 text-right font-normal">kept</th>
                <th className="w-20 py-1.5 text-right font-normal">segments</th>
                <th className="w-24 py-1.5 text-right font-normal">saved</th>
                <th className="w-24 py-1.5 text-right font-normal" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.title} className="border-t border-white/5 hover:bg-white/5">
                  <td className="py-1.5 text-center">
                    <input type="checkbox" checked={picked.has(r.title)} onChange={() => toggle(r.title)} />
                  </td>
                  <td className="min-w-0 py-1.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={r.exists ? 'text-emerald-400/70' : 'text-red-400/70'}
                        title={r.exists ? 'the film is there' : 'the film is not at that path any more'}>
                        ●
                      </span>
                      <span className="truncate text-white/80">{r.name}</span>
                    </div>
                    <div className="truncate pl-4 font-mono text-[10px] text-white/25">{r.source}</div>
                  </td>
                  <td className="py-1.5 text-right text-white/60">
                    {len(r.kept_seconds)}
                    {!!r.duration && (
                      <div className="text-[10px] text-white/25">of {len(r.duration)}</div>
                    )}
                  </td>
                  <td className="py-1.5 text-right text-white/40">
                    {r.kept}/{r.segments}
                  </td>
                  <td className="py-1.5 text-right text-white/35">{fmtDate(r.saved_at)}</td>
                  <td className="py-1.5 pr-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => onOpen(r.source)}
                        disabled={!r.exists}
                        title={r.exists ? 'Open this clip in the editor' : 'The film is not there to open'}
                        className="rounded px-1.5 py-0.5 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-20">
                        <Icon name="toEditor" />
                      </button>
                      <button
                        onClick={() => exportTitles([r.title], r.name.replace(/\.[^.]+$/, ''))}
                        disabled={!!busy}
                        title="Export just this cut list"
                        className="rounded px-1.5 py-0.5 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-30">
                        <Icon name="download" />
                      </button>
                      <button
                        onClick={() => deleteTitles([r.title], r.name)}
                        disabled={!!busy}
                        title="Delete this cut list"
                        className="rounded px-1.5 py-0.5 text-white/50 hover:bg-red-500/20 hover:text-red-200 disabled:opacity-30">
                        <Icon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ---------------------------------------------- typed confirmation */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setConfirm(null)}>
          <div className="material w-full max-w-md rounded-lg border border-white/15 shadow-xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-white/10 px-4 py-3 text-sm font-medium text-white/85">
              Delete {confirm.count} cut list{confirm.count === 1 ? '' : 's'}?
            </div>
            <div className="px-4 py-3 text-xs text-white/60">
              <p>
                About to delete <b className="text-white/85">{confirm.what}</b>. The films themselves are
                not touched — only the cuts.
              </p>
              <p className="mt-2 text-amber-200/80">
                This cannot be undone from inside the app. The only way back is a database download or a
                JSON export taken beforehand.
              </p>
              <label className="mt-3 block">
                Type <code className="rounded bg-white/10 px-1 text-white/80">delete</code> to confirm
                <input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') runConfirmed()
                    if (e.key === 'Escape') setConfirm(null)
                  }}
                  className="mt-1 w-full rounded bg-white/10 px-2 py-1 text-sm text-white outline-none"
                  placeholder="delete"
                />
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-3 text-xs">
              <button onClick={() => setConfirm(null)} className="rounded px-3 py-1 hover:bg-white/10">
                Cancel
              </button>
              <button
                onClick={runConfirmed}
                disabled={typed.trim().toLowerCase() !== 'delete'}
                className="rounded bg-red-500/80 px-3 py-1 text-white hover:bg-red-500 disabled:opacity-30">
                Delete {confirm.count}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
