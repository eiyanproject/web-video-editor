import { useCallback, useEffect, useRef, useState } from 'react'

// The edit model.
//
// Segments always tile the whole clip end to end with no gaps and no overlaps:
// deleting is a flag, never a removal. That mirrors the reference UI (crossed-out
// rows stay in the list) and it makes deletion reversible for free, which matters
// because a mis-click on a two-hour edit is otherwise expensive.
//
// Times are seconds. Frame indices are derived at the edges via fps, so a clip
// with a fractional rate (23.976, 29.97) does not accumulate drift.

export type Segment = {
  id: number
  start: number
  end: number
  keep: boolean
}

export const EPS = 1e-6

let nextId = 1
const mkId = () => nextId++

export const initialSegments = (duration: number): Segment[] =>
  duration > 0 ? [{ id: mkId(), start: 0, end: duration, keep: true }] : []

/** Splits the segment containing `t` in two. A split at an existing boundary is
 *  a no-op rather than an error - it is what a double-press produces. */
export function splitAt(segs: Segment[], t: number, minLen = 0.04): Segment[] {
  const i = segs.findIndex((s) => t > s.start + minLen && t < s.end - minLen)
  if (i < 0) return segs
  const s = segs[i]
  return [
    ...segs.slice(0, i),
    { id: mkId(), start: s.start, end: t, keep: s.keep },
    { id: mkId(), start: t, end: s.end, keep: s.keep },
    ...segs.slice(i + 1),
  ]
}

/**
 * Makes a loaded cut list tile [0, duration] with no gaps.
 *
 * Edits are plain JSON on a share, so they can be hand-edited, truncated, or
 * written against a different cut of the same film. Anything not covered is
 * filled in as excluded - which preserves the saved intent exactly, while
 * ensuring every point on the timeline belongs to some segment. Without this a
 * gap is a region you cannot cut in, for no visible reason.
 */
export function normalise(input: { start: number; end: number; keep: boolean }[], duration: number): Segment[] {
  const src = [...input]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  let cursor = 0
  for (const s of src) {
    const start = Math.max(cursor, Math.min(s.start, duration))
    const end = Math.min(s.end, duration)
    if (end - start < EPS) continue
    if (start - cursor > 0.01) {
      out.push({ id: mkId(), start: cursor, end: start, keep: false })
    }
    out.push({ id: mkId(), start, end, keep: s.keep })
    cursor = end
  }
  if (duration - cursor > 0.01) {
    out.push({ id: mkId(), start: cursor, end: duration, keep: false })
  }
  return out.length ? out : initialSegments(duration)
}

export function toggleKeep(segs: Segment[], id: number): Segment[] {
  return segs.map((s) => (s.id === id ? { ...s, keep: !s.keep } : s))
}

export function setKeep(segs: Segment[], id: number, keep: boolean): Segment[] {
  return segs.map((s) => (s.id === id ? { ...s, keep } : s))
}

/** Removes the boundary between segment `i` and `i+1`, merging them. The merged
 *  segment keeps the left side's flag. */
export function mergeAt(segs: Segment[], i: number): Segment[] {
  if (i < 0 || i >= segs.length - 1) return segs
  const a = segs[i], b = segs[i + 1]
  return [
    ...segs.slice(0, i),
    { id: mkId(), start: a.start, end: b.end, keep: a.keep },
    ...segs.slice(i + 2),
  ]
}

/** Moves the boundary between segment `i` and `i+1`, clamped so neither side
 *  collapses. Boundary 0 is the start of the clip and cannot move. */
export function moveBoundary(segs: Segment[], i: number, t: number, minLen = 0.04): Segment[] {
  if (i < 0 || i >= segs.length - 1) return segs
  const lo = segs[i].start + minLen
  const hi = segs[i + 1].end - minLen
  const clamped = Math.max(lo, Math.min(hi, t))
  const out = segs.map((s) => ({ ...s }))
  out[i].end = clamped
  out[i + 1].start = clamped
  return out
}

/** Interior boundaries, i.e. the actual cut points. The clip's own start and end
 *  are not cuts. */
export function boundaries(segs: Segment[]): number[] {
  return segs.slice(0, -1).map((s) => s.end)
}

export const keptDuration = (segs: Segment[]) =>
  segs.filter((s) => s.keep).reduce((n, s) => n + (s.end - s.start), 0)

// ---------------------------------------------------------------- cut cost

export type CutCost = {
  /** Lands exactly on a keyframe: pure stream copy, nothing re-encoded. */
  lossless: boolean
  /** Seconds of video that must be re-encoded to make this cut frame-exact. */
  reencode: number
  /** Distance to the nearest keyframe, signed. */
  toNearest: number
}

/**
 * What this cut will cost at export.
 *
 * A cut on a keyframe is free. Otherwise smart-cut re-encodes from the cut point
 * to the next keyframe, which is the visible price of frame accuracy - so the UI
 * can state it per cut rather than leaving the user to guess.
 */
export function cutCost(t: number, keyframes: number[], fps: number): CutCost {
  if (!keyframes.length) return { lossless: false, reencode: 0, toNearest: 0 }
  const frame = fps > 0 ? 1 / fps : 0.04

  // binary search for the first keyframe > t
  let lo = 0, hi = keyframes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid] <= t) lo = mid + 1
    else hi = mid
  }
  const next = keyframes[lo] ?? null
  const prev = lo > 0 ? keyframes[lo - 1] : null

  const dPrev = prev != null ? t - prev : Infinity
  const dNext = next != null ? next - t : Infinity
  const toNearest = dPrev <= dNext ? -dPrev : dNext

  if (Math.min(dPrev, dNext) < frame) {
    return { lossless: true, reencode: 0, toNearest: 0 }
  }
  // Everything from the cut to the next keyframe has to be rebuilt.
  return { lossless: false, reencode: next != null ? next - t : 0, toNearest }
}

export function snapToKeyframe(t: number, keyframes: number[]): number {
  if (!keyframes.length) return t
  let lo = 0, hi = keyframes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid] < t) lo = mid + 1
    else hi = mid
  }
  const a = keyframes[Math.max(0, lo - 1)]
  const b = keyframes[lo]
  return Math.abs(t - a) <= Math.abs(b - t) ? a : b
}

// ---------------------------------------------------------------- hook

/**
 * Segment state with undo/redo.
 *
 * History holds whole snapshots. An edit list is a few dozen small objects even
 * on a heavily cut film, so the simplicity is worth far more than the bytes a
 * diff-based scheme would save.
 */
export function useSegments(duration: number, clipKey: string) {
  const [segs, setSegs] = useState<Segment[]>([])
  const past = useRef<Segment[][]>([])
  const future = useRef<Segment[][]>([])
  const [, bump] = useState(0)

  // A new clip - or a duration arriving late - resets the edit.
  useEffect(() => {
    past.current = []
    future.current = []
    setSegs(initialSegments(duration))
  }, [clipKey, duration])

  const apply = useCallback((fn: (s: Segment[]) => Segment[]) => {
    setSegs((cur) => {
      const next = fn(cur)
      if (next === cur) return cur
      past.current = [...past.current.slice(-99), cur]
      future.current = []
      bump((n) => n + 1)
      return next
    })
  }, [])

  const undo = useCallback(() => {
    setSegs((cur) => {
      const prev = past.current.pop()
      if (!prev) return cur
      future.current = [cur, ...future.current.slice(0, 99)]
      bump((n) => n + 1)
      return prev
    })
  }, [])

  const redo = useCallback(() => {
    setSegs((cur) => {
      const [next, ...rest] = future.current
      if (!next) return cur
      future.current = rest
      past.current = [...past.current, cur]
      bump((n) => n + 1)
      return next
    })
  }, [])

  const reset = useCallback(() => apply(() => initialSegments(duration)), [apply, duration])

  return {
    segs,
    setSegs,
    apply,
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  }
}
