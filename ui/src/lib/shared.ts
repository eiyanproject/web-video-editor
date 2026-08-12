// Shared by the desktop app (App.tsx) and the phone app (phone/PhoneApp.tsx).
//
// These were all defined inside App.tsx. They moved here unchanged when the
// phone UI arrived, so the two front ends cannot drift on what a timecode is,
// how a size is rounded, or what shape a clip displays at. Pure functions and
// types only - nothing here touches React or the DOM.

/** A row in the file browser. Paths are absolute container paths throughout. */
export type Entry = {
  name: string
  abs: string
  is_dir: boolean
  size: number
  mtime: number
  is_video: boolean
  problem?: string
}

export const fmtSize = (n: number) => {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}

export const fmtDate = (ts: number) =>
  ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : ''

/** Accepts `1:02:03.500`, `02:03.5`, or plain seconds. Returns null if it is
 *  not a time at all, so a typo does not silently seek to zero. */
export function parseTimecode(s: string): number | null {
  const str = s.trim()
  if (!str) return null
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str)
  const m = str.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/)
  if (!m) return null
  const h = m[1] ? parseInt(m[1], 10) : 0
  const min = parseInt(m[2], 10)
  const sec = parseFloat(m[3])
  if (min > 59 || sec >= 60) return null
  return h * 3600 + min * 60 + sec
}

// HH:MM:SS.mmm - millisecond precision, which is what a cut point needs.
export const fmtTimecode = (t: number) => {
  if (!isFinite(t) || t < 0) t = 0
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const ms = Math.round((t - Math.floor(t)) * 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`
}

/**
 * Display aspect of a clip, honouring non-square pixels.
 *
 * Stored width over height is not the shape you see: a 854x480 file with a
 * 1280:1281 sample aspect displays as 16:9. Portrait phone footage is the case
 * that makes this visible - forcing everything into a 16:9 box would show it as
 * a sliver between two black slabs.
 */
export function displayAspect(p: { width: number; height: number; sar?: string } | null): number | null {
  if (!p?.width || !p?.height) return null
  let num = 1, den = 1
  const m = (p.sar ?? '').match(/^(\d+):(\d+)$/)
  if (m) { num = Number(m[1]); den = Number(m[2]) }
  if (!num || !den) { num = 1; den = 1 }
  return (p.width * num) / (p.height * den)
}

/** The port the phone UI is served on. The desktop header links to it, and the
 *  dev stack and nginx both listen there. One number, one place. */
export const PHONE_PORT = Number(import.meta.env.VITE_PHONE_PORT ?? 5274)
