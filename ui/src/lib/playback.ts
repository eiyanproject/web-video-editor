/**
 * Why a <video> refused to play, and telling the server about it.
 *
 * Playback happens entirely in the browser, so a player that will not decode
 * produces nothing on the server: the log shows a healthy box while the user
 * watches an error. Worse, the generic "this browser cannot play this file"
 * covers four unrelated causes - a dropped share, a damaged file, a codec the
 * build lacks, a request that never arrived - and tells you which one it was in
 * exactly none of those cases.
 *
 * So ask the browser directly. `canPlayType` answers whether this build can
 * decode H.264 and AAC AT ALL, which is the one question that separates "your
 * browser was compiled without the codec" - the usual answer when the same
 * file plays on one machine and not another - from everything else.
 */

export type Diagnosis = {
  /** What to show the user. */
  message: string
  /** Closed-set cause, for the log and for grouping. */
  kind: 'no_codec' | 'network' | 'decode' | 'aborted' | 'unsupported' | 'unknown'
  /** Everything worth having in the log line. */
  detail: Record<string, string>
}

/** The baseline H.264/AAC MP4 this app targets. */
const BASELINE = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'

/** `canPlayType` answers "probably" | "maybe" | "" - empty means never. */
function support(el: HTMLVideoElement) {
  const probe = (t: string) => {
    try { return el.canPlayType(t) || 'no' } catch { return 'error' }
  }
  return {
    mp4_h264_aac: probe(BASELINE),
    h264: probe('video/mp4; codecs="avc1.42E01E"'),
    aac: probe('audio/mp4; codecs="mp4a.40.2"'),
    mp4_any: probe('video/mp4'),
    webm_vp9: probe('video/webm; codecs="vp9"'),
  }
}

export function diagnose(el: HTMLVideoElement): Diagnosis {
  const s = support(el)
  const err = el.error
  const detail: Record<string, string> = {
    media_error: err ? String(err.code) : 'none',
    media_message: (err?.message || '').slice(0, 120) || 'none',
    network_state: String(el.networkState),
    ready_state: String(el.readyState),
    h264: s.h264,
    aac: s.aac,
    mp4_h264_aac: s.mp4_h264_aac,
    webm_vp9: s.webm_vp9,
    // Platform, not a full UA string: enough to tell a Linux build from a
    // Windows one without recording a fingerprint.
    platform: (navigator as any).userAgentData?.platform || navigator.platform || 'unknown',
  }

  // The decisive case, and the reason the same file plays on one machine and
  // not another: a browser built without the proprietary decoders. Chromium
  // packaged by several Linux distributions, and every ungoogled build, ship
  // with H.264 and AAC compiled out.
  if (s.h264 === 'no' || s.mp4_h264_aac === 'no') {
    const missing = [s.h264 === 'no' ? 'H.264 video' : null, s.aac === 'no' ? 'AAC audio' : null]
      .filter(Boolean)
      .join(' and ')
    return {
      kind: 'no_codec',
      detail,
      message:
        `This browser cannot decode ${missing || 'H.264/AAC'} — it was built without those codecs, ` +
        `which is common for Chromium packaged by Linux distributions. The file is fine and exporting ` +
        `is unaffected. Firefox, or a Chrome build with proprietary codecs, will play it.`,
    }
  }

  switch (err?.code) {
    case 1:
      return { kind: 'aborted', detail, message: 'Loading was aborted.' }
    case 2:
      return {
        kind: 'network',
        detail,
        message:
          'Network error while reading the file — the share may have dropped, or the connection ' +
          'was interrupted mid-stream.',
      }
    case 3:
      // Which stream failed is the whole difference between "nothing can be
      // done here" and "there is a button for this". Chromium names it in the
      // message: a damaged audio packet reads as "Failed to send audio packet
      // for decoding", and that case is repairable, so say so rather than
      // sending the user to a deep check that only reads the first and last
      // twenty seconds and will almost certainly come back clean.
      return {
        kind: 'decode',
        detail,
        message: /audio/i.test(err?.message || '')
          ? 'Decode error in the audio: a damaged or missing audio frame, which this browser ' +
            'refuses while Windows and phones skip past it. The video is fine and exports repair ' +
            'the audio automatically — use Fix audio in the media panel to make this file ' +
            'playable here too.'
          : 'Decode error: the stream is damaged at this point. The browser can handle this ' +
            'format, so this is the file rather than the player — run the deep check from the ' +
            'media panel.',
      }
    case 4:
      return {
        kind: 'unsupported',
        detail,
        message:
          'This browser can play H.264/AAC but refused this file, so it is the container or a ' +
          'secondary stream it dislikes (HEVC, MKV or AC3 audio). Export is unaffected.',
      }
    default:
      return {
        kind: 'unknown',
        detail,
        message: err?.message || 'Playback failed, and the browser gave no reason.',
      }
  }
}

/** Sends a diagnosis to the server log. Best effort - never block playback. */
export function reportPlaybackError(d: Diagnosis, clip?: string) {
  const detail: Record<string, string> = { ...d.detail, kind: d.kind }
  // Name only, never the path: the log is read over someone's shoulder and the
  // folder adds nothing to diagnosing a decoder.
  if (clip) detail.clip = clip.split(/[\\/]/).pop()?.slice(0, 80) ?? ''
  fetch('/api/client-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'error', msg: `playback failed: ${d.message}`, detail }),
    keepalive: true,
  }).catch(() => {})
}

/**
 * One check at startup, so a browser that can never play anything says so once
 * rather than only when a file is opened. Reported at warn: it is not an error
 * yet, but it is the explanation for every playback error that follows.
 */
export function reportCodecSupportOnce() {
  const KEY = 'veditor.codecReported'
  try { if (sessionStorage.getItem(KEY)) return } catch { /* private mode */ }
  const el = document.createElement('video')
  const s = support(el)
  if (s.h264 !== 'no' && s.mp4_h264_aac !== 'no') return
  try { sessionStorage.setItem(KEY, '1') } catch { /* ignore */ }
  fetch('/api/client-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      level: 'warn',
      msg: 'browser cannot decode H.264/AAC - every preview will fail on this machine',
      detail: {
        h264: s.h264,
        aac: s.aac,
        mp4_h264_aac: s.mp4_h264_aac,
        webm_vp9: s.webm_vp9,
        platform: (navigator as any).userAgentData?.platform || navigator.platform || 'unknown',
      },
    }),
  }).catch(() => {})
}
