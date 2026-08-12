import { useEffect, useState } from 'react'
import FolderPicker from './FolderPicker'

type RootCfg = { name: string; path: string; writable: boolean }
type SmbPublic = {
  name: string
  address: string
  username: string
  domain: string
  mountpoint: string
  read_only: boolean
  auto_mount: boolean
  options: string
  has_password: boolean
  mounted: boolean
  online: boolean
  ever_checked: boolean
  last_error: string
  checked_at: number
}
type SettingsData = {
  roots: RootCfg[]
  smb: SmbPublic[]
  allow_any_path: boolean
  output_dir: string
  edits_dir: string
  autosave_edits: boolean
  default_username: string
  default_domain: string
  has_default_password: boolean
}

// Passwords are write-only: the server never sends one back, so this field
// stays blank on load and an empty value means "keep what's stored".
type SmbDraft = SmbPublic & { password: string; clear_password?: boolean }

const blankShare = (): SmbDraft => ({
  name: '',
  address: '',
  username: '',
  password: '',
  domain: '',
  mountpoint: '',
  read_only: true,
  auto_mount: true,
  options: '',
  has_password: false,
  mounted: false,
  online: false,
  ever_checked: false,
  last_error: '',
  checked_at: 0,
})

export default function Settings({
  onClose,
  startWithShare = false,
}: {
  onClose: () => void
  /// Set when the user arrived here from "nothing connected" - open a blank
  /// share form immediately instead of showing them an empty page.
  startWithShare?: boolean
}) {
  const [data, setData] = useState<SettingsData | null>(null)
  const [shares, setShares] = useState<SmbDraft[]>([])
  const [roots, setRoots] = useState<RootCfg[]>([])
  const [allowAny, setAllowAny] = useState(true)
  const [outputDir, setOutputDir] = useState('')
  const [defUser, setDefUser] = useState('')
  const [defPass, setDefPass] = useState('')
  const [defDomain, setDefDomain] = useState('')
  const [hasDefPass, setHasDefPass] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  type PathCheck = { exists: boolean; is_dir: boolean; writable: boolean; on_mount: boolean; message: string }
  const [pathCheck, setPathCheck] = useState<PathCheck | null>(null)
  const [editsDir, setEditsDir] = useState('')
  const [autosaveEdits, setAutosaveEdits] = useState(true)
  const [editsCheck, setEditsCheck] = useState<PathCheck | null>(null)
  const [picking, setPicking] = useState<null | 'edits' | 'output'>(null)
  const [savedEdits, setSavedEdits] = useState<
    { source: string; name: string; segments: number; kept: number; saved_at: number; exists: boolean }[]
  >([])

  const checkEdits = async () => {
    setBusy('checkEdits')
    try {
      const r = await fetch('/api/check-path', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: editsDir }),
      })
      setEditsCheck(await r.json())
    } finally { setBusy(null) }
  }

  // Existence is not enough: a read-only share looks like a perfectly good
  // folder right up until the export fails on the last step.
  const checkOutput = async () => {
    setBusy('check')
    try {
      const r = await fetch('/api/check-path', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: outputDir }),
      })
      setPathCheck(await r.json())
    } finally { setBusy(null) }
  }

  const load = async () => {
    const d: SettingsData = await (await fetch('/api/settings')).json()
    setData(d)
    setRoots(d.roots)
    setAllowAny(d.allow_any_path)
    setOutputDir(d.output_dir)
    setEditsDir(d.edits_dir ?? '')
    setAutosaveEdits(d.autosave_edits ?? true)
    fetch('/api/edits').then((r) => r.json()).then(setSavedEdits).catch(() => {})
    setDefUser(d.default_username)
    setDefDomain(d.default_domain)
    setHasDefPass(d.has_default_password)
    const drafts = d.smb.map((s) => ({ ...s, password: '' }))
    setShares(startWithShare && drafts.length === 0 ? [blankShare()] : drafts)
  }

  useEffect(() => { load() }, [])

  // Refreshes ONLY server-owned status, leaving everything the user has typed
  // alone. Calling the full load() here would wipe the draft - including the
  // password, which the server never sends back.
  const refreshStatus = async () => {
    const d: SettingsData = await (await fetch('/api/settings')).json()
    setData(d)
    setHasDefPass(d.has_default_password)
    setShares((cur) =>
      cur.map((c) => {
        const srv = d.smb.find((s) => s.name === c.name)
        return srv ? { ...c, mounted: srv.mounted, has_password: srv.has_password } : c
      }),
    )
    setRoots(d.roots)
  }

  const persist = async () => {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roots,
        smb: shares.map(({ has_password, mounted, ...s }) => s),
        allow_any_path: allowAny,
        output_dir: outputDir,
        edits_dir: editsDir,
        autosave_edits: autosaveEdits,
        default_username: defUser,
        default_password: defPass,
        default_domain: defDomain,
      }),
    })
    if (!r.ok) throw new Error((await r.json()).error)
  }

  const save = async () => {
    setBusy('save'); setMsg(null)
    try {
      await persist()
      // Passwords have landed on the server; clear the local boxes so they show
      // the "stored" state rather than sitting there in plain text.
      setDefPass('')
      setShares((cur) => cur.map((c) => ({ ...c, password: '' })))
      await refreshStatus()
      setMsg({ kind: 'ok', text: 'Saved to config/settings.json — it will still be there after a rebuild.' })
    } catch (e: any) {
      setMsg({ kind: 'err', text: String(e.message ?? e) })
    } finally { setBusy(null) }
  }

  // Test and Mount save first, so nothing you typed is lost and you never have
  // to enter it twice. Status is then refreshed without touching the draft.
  const act = async (url: string, body: any, label: string) => {
    setBusy(label); setMsg(null)
    try {
      await persist()
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setShares((cur) => cur.map((c) => ({ ...c, password: '' })))
      setDefPass('')
      await refreshStatus()
      setMsg({ kind: 'ok', text: `${d.message ?? 'Done.'} (your entries were saved)` })
    } catch (e: any) {
      setMsg({ kind: 'err', text: String(e.message ?? e) })
    } finally { setBusy(null) }
  }

  const upd = (i: number, patch: Partial<SmbDraft>) =>
    setShares(shares.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  const field = 'w-full rounded bg-white/10 px-2 py-1 text-sm outline-none placeholder:text-white/25'

  // Each box only accepts what it can actually hold. Rejecting a stray character
  // as it is typed is kinder than accepting it and failing at mount time with a
  // message about the wrong thing.
  const cleanPath = (v: string) => v.replace(/[\r\n\t]/g, '').replace(/^\s+/, '')
  const cleanShareName = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)
  const cleanUser = (v: string) => v.replace(/[\r\n\t\s]/g, '').slice(0, 128)
  const cleanOptions = (v: string) => v.replace(/[\r\n\t\s]/g, '').slice(0, 200)

  if (!data) return <div className="p-6 text-white/40">Loading…</div>

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        <button onClick={onClose} className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
          ← Back to editor
        </button>
      </div>

      {msg && (
        <div className={`mb-4 rounded px-3 py-2 text-sm ${
          msg.kind === 'ok' ? 'bg-emerald-500/20 text-emerald-100' : 'bg-red-500/20 text-red-100'
        }`}>
          {msg.text}
        </div>
      )}

      {/* ---------------------------------------------- SMB shares */}
      <section className="mb-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Network shares (SMB / Samba)</h2>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                setBusy('all'); setMsg(null)
                try {
                  const d = await (await fetch('/api/smb/mount-all', { method: 'POST' })).json()
                  const ok = d.results.filter((r: any) => r.ok).length
                  const bad = d.results.filter((r: any) => !r.ok)
                  await refreshStatus()
                  setMsg(bad.length
                    ? { kind: 'err', text: `${ok} connected. Failed: ${bad.map((b: any) => `${b.name} (${b.message})`).join('; ')}` }
                    : { kind: 'ok', text: ok ? `${ok} share${ok > 1 ? 's' : ''} connected.` : 'Nothing to reconnect.' })
                } finally { setBusy(null) }
              }}
              disabled={!!busy || !shares.length}
              className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20 disabled:opacity-40"
            >
              {busy === 'all' ? 'Reconnecting…' : '⟳ Reconnect all'}
            </button>
            <button
              onClick={() => setShares([...shares, blankShare()])}
              className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
            >
              + Add share
            </button>
          </div>
        </div>
        <p className="mb-3 text-xs text-white/40">
          Saved to <code>config/settings.json</code> on the host, so you enter it once.
          Mounting a share automatically adds it as a library folder.
        </p>

        {/* One account usually covers every share on the same NAS, so it is
            entered once here and reused by any share that leaves it blank. */}
        <div className="mb-4 rounded border border-white/10 bg-white/[0.03] p-3">
          <div className="mb-1 text-sm text-white/80">Default credentials</div>
          <p className="mb-2 text-xs text-white/40">
            Used by any share below that leaves its own username or password empty.
            Enter your NAS login once here instead of repeating it per share.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-white/50">
              Username
              <input className={field} value={defUser} autoComplete="off"
                onChange={(e) => setDefUser(cleanUser(e.target.value))} />
            </label>
            <label className="text-xs text-white/50">
              Password {hasDefPass && (
                <button
                  onClick={async () => {
                    await fetch('/api/settings', {
                      method: 'PUT', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ clear_default_password: true }),
                    })
                    setDefPass(''); await refreshStatus()
                    setMsg({ kind: 'ok', text: 'Default password forgotten.' })
                  }}
                  className="text-red-300 underline hover:text-red-200"
                >forget</button>
              )}
              <input className={field} type="password" value={defPass} autoComplete="new-password"
                placeholder={hasDefPass ? '•••••••• (stored)' : ''}
                onChange={(e) => setDefPass(e.target.value)} />
            </label>
            <label className="text-xs text-white/50">
              Domain / workgroup
              <input className={field} value={defDomain}
                onChange={(e) => setDefDomain(cleanUser(e.target.value))} />
            </label>
          </div>
        </div>

        {startWithShare && (
          <ol className="mb-3 list-inside list-decimal space-y-1 rounded border border-indigo-400/30 bg-indigo-500/10 p-3 text-xs text-white/60">
            <li>Give it a short <b>name</b> — this becomes the folder name in your library.</li>
            <li>Enter the <b>address</b>, e.g. <code className="text-white/80">\\192.168.1.10\media</code> or <code className="text-white/80">//nas/media</code>.</li>
            <li>Fill in the <b>username and password</b> for that share.</li>
            <li>Press <b>Test</b> to check it, then <b>Mount</b>.</li>
            <li>Press <b>Save settings</b> at the bottom so it comes back automatically next time.</li>
          </ol>
        )}

        {shares.map((s, i) => (
          <div key={i} className="mb-3 rounded border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${
                s.mounted ? 'bg-emerald-400' : s.ever_checked ? 'bg-red-400' : 'bg-white/25'
              }`} />
              <span className="text-sm text-white/60">
                {s.mounted ? 'connected' : s.ever_checked ? 'offline' : 'not connected yet'}
              </span>
              {!s.mounted && s.ever_checked && s.checked_at > 0 && (
                <span className="text-xs text-white/30">
                  last tried {new Date(s.checked_at * 1000).toLocaleTimeString(undefined, { hour12: false })}
                </span>
              )}
              <div className="flex-1" />
              <button
                onClick={() => act('/api/smb/test', { ...s, has_password: undefined, mounted: undefined }, `test${i}`)}
                disabled={!!busy}
                className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20 disabled:opacity-40"
              >
                {busy === `test${i}` ? 'Testing…' : 'Test'}
              </button>
              <button
                onClick={() => act(s.mounted ? '/api/smb/unmount' : '/api/smb/mount', { name: s.name }, `mnt${i}`)}
                disabled={!!busy || !s.name}
                className="rounded bg-indigo-500/70 px-2 py-1 text-xs hover:bg-indigo-500 disabled:opacity-40"
              >
                {busy === `mnt${i}` ? '…' : s.mounted ? 'Unmount' : s.ever_checked ? 'Reconnect' : 'Mount'}
              </button>
              <button
                onClick={() => setShares(shares.filter((_, j) => j !== i))}
                className="rounded bg-red-500/20 px-2 py-1 text-xs text-red-200 hover:bg-red-500/40"
              >
                Remove
              </button>
            </div>

            {!s.mounted && s.ever_checked && s.last_error && (
              <div className="mb-2 rounded border-l-2 border-red-400 bg-red-500/15 px-3 py-2 text-xs text-red-100">
                <b>Offline.</b> {s.last_error}
                <div className="mt-1 text-red-100/60">
                  Nothing is retrying in the background — press <b>Reconnect</b> when the
                  NAS is back up.
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-white/50">
                Name
                <input className={field} value={s.name} placeholder="nas"
                  title="Used as the folder name under /mnt/smb, so letters, digits, dot, dash and underscore only"
                  onChange={(e) => upd(i, { name: cleanShareName(e.target.value) })} />
              </label>
              <label className="text-xs text-white/50">
                Address
                <input className={field} value={s.address} placeholder="\\192.168.1.10\media"
                  onChange={(e) => upd(i, { address: cleanPath(e.target.value) })} />
              </label>
              <label className="text-xs text-white/50">
                Username
                <input className={field} value={s.username} autoComplete="off"
                  placeholder={defUser || data.default_username ? 'using default' : ''}
                  onChange={(e) => upd(i, { username: cleanUser(e.target.value) })} />
              </label>
              <label className="text-xs text-white/50">
                Password {s.has_password && (
                  <button onClick={() => upd(i, { clear_password: true, password: '' })}
                    className="text-red-300 underline hover:text-red-200">forget</button>
                )}
                {s.clear_password && <span className="text-red-300"> will be cleared on save</span>}
                <input className={field} type="password" value={s.password} autoComplete="new-password"
                  placeholder={s.has_password ? '••••••••' : hasDefPass ? 'using default' : ''}
                  onChange={(e) => upd(i, { password: e.target.value })} />
              </label>
              <label className="text-xs text-white/50">
                Domain / workgroup <span className="text-white/25">(optional)</span>
                <input className={field} value={s.domain}
                  onChange={(e) => upd(i, { domain: cleanUser(e.target.value) })} />
              </label>
              <label className="text-xs text-white/50">
                Mount point <span className="text-white/25">(blank → /mnt/smb/{s.name || 'name'})</span>
                <input className={field} value={s.mountpoint}
                  onChange={(e) => upd(i, { mountpoint: cleanPath(e.target.value) })} />
              </label>
              <label className="col-span-2 text-xs text-white/50">
                Extra mount options <span className="text-white/25">(e.g. vers=2.1 for older NAS)</span>
                <input className={field} value={s.options} placeholder="vers=3.0"
                  title="Comma-separated mount options, no spaces"
                  onChange={(e) => upd(i, { options: cleanOptions(e.target.value) })} />
              </label>
            </div>

            <div className="mt-2 flex gap-4 text-xs text-white/60">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={s.read_only}
                  onChange={(e) => upd(i, { read_only: e.target.checked })} />
                Read-only (recommended for source media)
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={s.auto_mount}
                  onChange={(e) => upd(i, { auto_mount: e.target.checked })} />
                Mount automatically on startup
              </label>
            </div>
          </div>
        ))}
        {!shares.length && (
          <div className="rounded border border-dashed border-white/15 p-5 text-center">
            <div className="mb-1 text-sm text-white/60">No network shares yet</div>
            <p className="mx-auto mb-3 max-w-md text-xs leading-relaxed text-white/40">
              If your videos live on a NAS or another PC, add it here once and it will be
              reconnected automatically from then on. Shares are mounted read-only by
              default, so nothing can modify your originals.
            </p>
            <button onClick={() => setShares([blankShare()])}
              className="rounded bg-indigo-500 px-3 py-2 text-xs font-medium hover:bg-indigo-400">
              + Add your first share
            </button>
          </div>
        )}

        <details className="mt-3 rounded bg-white/[0.03] p-3 text-xs text-white/50">
          <summary className="cursor-pointer text-white/70">If a share will not connect</summary>
          <ul className="mt-2 list-inside list-disc space-y-1">
            <li><b>Permission denied / must be superuser</b> — the container needs <code>CAP_SYS_ADMIN</code>. Already set in <code>docker-compose.dev.yml</code>. On an <i>unprivileged</i> Proxmox LXC this cannot work at all; mount on the host and add it as a library folder instead.</li>
            <li><b>Host is down / no route</b> — check the IP, and that the NAS is not asleep.</li>
            <li><b>Older NAS</b> — put <code>vers=2.1</code> or <code>vers=1.0</code> in extra options.</li>
            <li><b>Wrong credentials</b> — some NAS boxes need the domain or workgroup filled in.</li>
            <li>Address works with backslashes or forward slashes; both are accepted.</li>
          </ul>
        </details>
      </section>

      {/* ---------------------------------------------- roots */}
      <section className="mb-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Library folders</h2>
          <div className="flex gap-2">
            <button
              title="Drop folders whose share is not mounted. A renamed or removed share leaves one behind, and it just reads as 'not found' when you browse."
              onClick={async () => {
                const checks = await Promise.all(roots.map(async (r) => {
                  try {
                    const d = await (await fetch('/api/check-path', {
                      method: 'POST', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ path: r.path }),
                    })).json()
                    return d.is_dir
                  } catch { return true }
                }))
                const keep = roots.filter((_, i) => checks[i])
                const dropped = roots.length - keep.length
                setRoots(keep)
                setMsg(dropped
                  ? { kind: 'ok', text: `${dropped} unreachable folder(s) removed — press Save to keep the change.` }
                  : { kind: 'ok', text: 'Every library folder is reachable.' })
              }}
              className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
            >
              Remove unreachable
            </button>
            <button
              onClick={() => setRoots([...roots, { name: '', path: '', writable: false }])}
              className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
            >
              + Add folder
            </button>
          </div>
        </div>
        {roots.map((r, i) => (
          <div key={i} className="mb-2 flex gap-2">
            <input className={`${field} w-40`} value={r.name} placeholder="name"
              onChange={(e) => setRoots(roots.map((x, j) => (j === i ? { ...x, name: cleanShareName(e.target.value) } : x)))} />
            <input className={field} value={r.path} placeholder="/media or /mnt/smb/nas"
              onChange={(e) => setRoots(roots.map((x, j) => (j === i ? { ...x, path: cleanPath(e.target.value) } : x)))} />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-white/60">
              <input type="checkbox" checked={r.writable}
                onChange={(e) => setRoots(roots.map((x, j) => (j === i ? { ...x, writable: e.target.checked } : x)))} />
              writable
            </label>
            <button onClick={() => setRoots(roots.filter((_, j) => j !== i))}
              className="shrink-0 rounded bg-red-500/20 px-2 text-xs text-red-200 hover:bg-red-500/40">✕</button>
          </div>
        ))}
      </section>

      {/* ---------------------------------------------- general */}
      {/* ---------------------------------------------- saved edits */}
      <section className="mb-8">
        <h2 className="mb-2 font-medium">Saved edits</h2>
        <p className="mb-2 text-xs text-white/40">
          Your cut lists are written here, one small JSON file per clip. Put this folder
          <b className="text-white/60"> on the share</b> rather than inside the container:
          the cuts then live with the media, survive a rebuild, and travel with the library
          if it ever moves. Reopening a clip loads its cuts back automatically.
        </p>
        <div className="flex gap-2">
          <button onClick={() => setPicking('edits')} title="Browse for a folder"
            className="shrink-0 rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">📂 Browse</button>
          <input className={field} value={editsDir} placeholder="/mnt/smb/nas/.video-edits"
            onChange={(e) => { setEditsDir(cleanPath(e.target.value)); setEditsCheck(null) }} />
          <button onClick={checkEdits} disabled={!editsDir.trim() || busy === 'checkEdits'}
            className="shrink-0 rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20 disabled:opacity-40">
            {busy === 'checkEdits' ? 'Checking…' : 'Check'}
          </button>
        </div>
        {editsCheck && (
          <div className={`mt-2 rounded px-3 py-2 text-xs ${
            editsCheck.writable && editsCheck.on_mount ? 'bg-emerald-500/20 text-emerald-100'
              : editsCheck.writable ? 'bg-amber-500/20 text-amber-100'
              : 'bg-red-500/20 text-red-100'
          }`}>
            {editsCheck.message}
          </div>
        )}
        <label className="mt-2 flex items-center gap-2 text-sm text-white/70">
          <input type="checkbox" checked={autosaveEdits} onChange={(e) => setAutosaveEdits(e.target.checked)} />
          Save cuts automatically as I edit
        </label>
        {!!savedEdits.length && (
          <div className="mt-3 rounded border border-white/10">
            <div className="border-b border-white/10 px-2 py-1 text-xs text-white/50">
              {savedEdits.length} saved {savedEdits.length === 1 ? 'edit' : 'edits'}
            </div>
            <div className="max-h-40 overflow-y-auto">
              {savedEdits.map((e) => (
                <div key={e.source} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-white/5">
                  <span className={e.exists ? 'text-emerald-400/70' : 'text-red-400/70'}
                    title={e.exists ? 'source present' : 'source file is missing'}>●</span>
                  <span className="min-w-0 flex-1 truncate text-white/70">{e.name}</span>
                  <span className="shrink-0 text-white/35">{e.kept}/{e.segments} kept</span>
                  <span className="shrink-0 text-white/25">
                    {e.saved_at ? new Date(e.saved_at * 1000).toLocaleDateString() : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 font-medium">Export destination</h2>

        {roots.length === 0 ? (
          <div className="rounded border border-dashed border-amber-400/30 bg-amber-500/10 p-4 text-xs text-amber-100">
            <b>Connect a share or add a folder first.</b>
            <div className="mt-1 text-amber-100/70">
              There is no export destination until you have somewhere to write to. Nothing
              is set by default on purpose — an export folder you did not choose is how a
              volume quietly fills up.
            </div>
          </div>
        ) : (
          <>
            <label className="mb-2 block text-xs text-white/50">
              Where exports are written
              <div className="flex gap-2">
                <button onClick={() => setPicking('output')} title="Browse for a folder"
                  className="shrink-0 rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20">📂 Browse</button>
                <input className={field} value={outputDir} placeholder="/mnt/smb/nas/edited"
                  onChange={(e) => { setOutputDir(cleanPath(e.target.value)); setPathCheck(null) }} />
                <button onClick={checkOutput} disabled={!outputDir.trim() || busy === 'check'}
                  className="shrink-0 rounded bg-white/10 px-3 py-1 text-xs hover:bg-white/20 disabled:opacity-40">
                  {busy === 'check' ? 'Checking…' : 'Check'}
                </button>
              </div>
            </label>

            {pathCheck && (
              <div className={`mb-2 rounded px-3 py-2 text-xs ${
                pathCheck.writable && pathCheck.on_mount ? 'bg-emerald-500/20 text-emerald-100'
                  : pathCheck.writable ? 'bg-amber-500/20 text-amber-100'
                  : 'bg-red-500/20 text-red-100'
              }`}>
                {pathCheck.message}
              </div>
            )}

            <div className="mb-3 flex flex-wrap gap-1">
              {roots.filter((r) => r.writable).map((r) => (
                <button key={r.path} onClick={() => { setOutputDir(r.path); setPathCheck(null) }}
                  className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
                  use {r.name}
                </button>
              ))}
              {!roots.some((r) => r.writable) && (
                <span className="text-xs text-amber-200/70">
                  None of your folders are writable — untick “Read-only” on a share to export to it.
                </span>
              )}
            </div>
          </>
        )}
        <label className="flex items-center gap-2 text-sm text-white/70">
          <input type="checkbox" checked={allowAny} onChange={(e) => setAllowAny(e.target.checked)} />
          Allow opening any path, not just library folders
        </label>
      </section>

      {picking && (
        <FolderPicker
          title={picking === 'edits' ? 'Choose the folder for saved edits' : 'Choose the export folder'}
          initial={picking === 'edits' ? editsDir : outputDir}
          onClose={() => setPicking(null)}
          onPick={(p) => {
            if (picking === 'edits') { setEditsDir(p); setEditsCheck(null) }
            else { setOutputDir(p); setPathCheck(null) }
            setPicking(null)
          }}
        />
      )}

      <div className="sticky bottom-0 -mx-6 border-t border-white/10 bg-[#0f1116] px-6 py-3">
        <button onClick={save} disabled={!!busy}
          className="rounded bg-indigo-500 px-4 py-2 text-sm font-medium hover:bg-indigo-400 disabled:opacity-40">
          {busy === 'save' ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  )
}
