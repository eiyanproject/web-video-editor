/**
 * Interaction telemetry, for working out what the UI actually gets wrong.
 *
 * The question this is built to answer is not "how many people clicked
 * Export". It is the narrower, more useful one: **which keys does the user
 * press that do nothing**, and which buttons do they still reach for a mouse
 * to hit. A key pressed that matches no binding is the single most valuable
 * signal a keyboard-first tool can collect - it is a user telling you, without
 * being asked, what they expected the app to do.
 *
 * What it deliberately does NOT record:
 *
 *   - no file names, folder names or paths, ever
 *   - no timecodes, durations or file sizes
 *   - no free text: not filter terms, not typed paths
 *   - nothing from the media itself
 *
 * Events are counts of interface actions and nothing else, which is what makes
 * the file safe to hand to someone. The one place real strings could leak in is
 * a key name, and those are drawn from a closed set of key identifiers.
 *
 * It is local: batches go to this app's own API, which appends them to a file
 * beside the settings. Nothing leaves the machine unless the file is exported
 * by hand.
 */

export type TelemetryEvent = {
  /** Closed set. Adding one means adding it here first, on purpose. */
  kind:
    | 'shortcut'         // a bound key fired
    | 'shortcut_miss'    // a key pressed outside a text field that is bound to nothing
    | 'shortcut_blocked' // bound, but refused - no clip, job running
    | 'click'            // a control with a stable id
    | 'menu'             // an overflow menu opened
    | 'export'           // an export started
    | 'error'
  /** A stable identifier, never user content. */
  id: string
  /** Optional closed-set detail, e.g. why a shortcut was blocked. */
  detail?: string
  at: number
}

const KEY = 'veditor.telemetry.enabled'
const QUEUE_MAX = 400
const FLUSH_MS = 20_000

let queue: TelemetryEvent[] = []
let timer: number | null = null

/** Default ON: this is a single-user tool on the user's own hardware, the data
 *  never leaves it, and the whole point is to collect enough to be useful. */
export function enabled(): boolean {
  try { return localStorage.getItem(KEY) !== '0' } catch { return false }
}

export function setEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* private mode */ }
  if (!on) queue = []
}

/** Which front end this came from, so desktop and touch can be told apart. */
function surface(): string {
  return location.port === '5274' || document.title.includes('phone') ? 'touch' : 'desktop'
}

async function flush() {
  if (!queue.length) return
  const batch = queue
  queue = []
  try {
    await fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ surface: surface(), events: batch }),
      keepalive: true,
    })
  } catch {
    // Losing a batch is fine - this is aggregate interaction data, not the
    // edit. Never retry into an unbounded buffer.
  }
}

export function track(kind: TelemetryEvent['kind'], id: string, detail?: string) {
  if (!enabled()) return
  if (queue.length >= QUEUE_MAX) return
  queue.push({ kind, id, detail, at: Date.now() })
  if (timer == null) {
    timer = window.setTimeout(() => { timer = null; flush() }, FLUSH_MS)
  }
}

/** Flush on the way out, so a session's last actions are not the ones lost. */
export function installTelemetryFlush() {
  const out = () => { if (document.visibilityState === 'hidden') flush() }
  document.addEventListener('visibilitychange', out)
  window.addEventListener('pagehide', flush)
}
