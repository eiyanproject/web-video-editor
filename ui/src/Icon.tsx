/**
 * The icon set.
 *
 * These replace the emoji the UI used to draw its controls with. Emoji were
 * the single loudest thing stopping this looking like a native app: they are
 * multicolour where the rest of the interface is monochrome, they sit on their
 * own baseline, they cannot take the colour of the text beside them, and -
 * worst for a tool used across several Linux distros - they render as a
 * different picture on every machine. Noto Color Emoji, Segoe UI Emoji and
 * Apple Color Emoji do not agree on what a floppy disk looks like.
 *
 * Drawn in the SF Symbols idiom: a 16px box, 1.5px strokes, round caps and
 * joins, no fills. Everything is `currentColor`, so an icon is simply the
 * colour of the text it sits with, and one disabled or hovered state covers
 * both without a second rule.
 */

export type IconName =
  | 'folder' | 'folderOpen' | 'film' | 'file' | 'warning'
  | 'close' | 'check' | 'home' | 'up' | 'refresh' | 'star'
  | 'copy' | 'phone' | 'keyboard' | 'list' | 'gear' | 'save'
  | 'scissors' | 'undo' | 'redo' | 'merge' | 'trash'
  | 'clock' | 'volume' | 'mute' | 'fullscreen' | 'eject'
  | 'image' | 'wave' | 'search' | 'target' | 'download'
  | 'arrowLeft' | 'arrowRight' | 'arrowDown' | 'toEditor' | 'more' | 'network'

const P: Record<IconName, React.ReactNode> = {
  folder: <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .78.37l.74.92h5.88a1 1 0 0 1 1 1v6.09a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />,
  folderOpen: <path d="M1.75 12.63V4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .78.37l.74.92h5.88a1 1 0 0 1 1 1v1.1M1.75 12.63l1.72-4.4a1 1 0 0 1 .93-.63h10.1a.6.6 0 0 1 .56.82l-1.55 4a1 1 0 0 1-.93.64H2.75a1 1 0 0 1-1-.43z" />,
  film: <><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.6" /><path d="M4.6 2.75v10.5M11.4 2.75v10.5" /><path d="M2.9 5.3h.01M2.9 8h.01M2.9 10.7h.01M13.1 5.3h.01M13.1 8h.01M13.1 10.7h.01" /></>,
  file: <><path d="M3.75 2.25h5l3.5 3.5v8a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z" /><path d="M8.75 2.25v3.5h3.5" /></>,
  warning: <><path d="M7.13 2.6 1.6 12.1a1 1 0 0 0 .87 1.5h11.06a1 1 0 0 0 .87-1.5L8.87 2.6a1 1 0 0 0-1.74 0z" /><path d="M8 6.4v3M8 11.3v.01" /></>,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3.5 8.5l3 3 6-6" />,
  home: <><path d="M2.5 6.8 8 2.5l5.5 4.3v6a.7.7 0 0 1-.7.7H3.2a.7.7 0 0 1-.7-.7z" /><path d="M6.3 13.5V9.2h3.4v4.3" /></>,
  up: <path d="M8 13V3.5M8 3.5 3.8 7.7M8 3.5l4.2 4.2" />,
  refresh: <><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75" /><path d="M13.5 2.2v3h-3" /></>,
  star: <path d="m8 2.2 1.82 3.7 4.08.6-2.95 2.87.7 4.06L8 11.51 4.35 13.4l.7-4.06L2.1 6.5l4.08-.6z" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  phone: <><rect x="4.5" y="1.75" width="7" height="12.5" rx="1.6" /><path d="M7 12.4h2" /></>,
  keyboard: <><rect x="1.5" y="4" width="13" height="8" rx="1.2" /><path d="M4 6.6h.01M6.5 6.6h.01M9 6.6h.01M11.5 6.6h.01M5 9.4h6" /></>,
  list: <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01" />,
  gear: <><circle cx="8" cy="8" r="2.2" /><path d="M12.9 9.8a1.1 1.1 0 0 0 .22 1.21l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.21-.22 1.1 1.1 0 0 0-.67 1v.11a1.33 1.33 0 0 1-2.66 0v-.06a1.1 1.1 0 0 0-.72-1 1.1 1.1 0 0 0-1.21.22l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .22-1.21 1.1 1.1 0 0 0-1-.67h-.11a1.33 1.33 0 0 1 0-2.66h.06a1.1 1.1 0 0 0 1-.72 1.1 1.1 0 0 0-.22-1.21l-.04-.04a1.33 1.33 0 1 1 1.88-1.88l.04.04a1.1 1.1 0 0 0 1.21.22h.05a1.1 1.1 0 0 0 .67-1v-.11a1.33 1.33 0 0 1 2.66 0v.06a1.1 1.1 0 0 0 .67 1 1.1 1.1 0 0 0 1.21-.22l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.22 1.21v.05a1.1 1.1 0 0 0 1 .67h.11a1.33 1.33 0 0 1 0 2.66h-.06a1.1 1.1 0 0 0-1 .67z" /></>,
  save: <><path d="M2.5 3.7a1.2 1.2 0 0 1 1.2-1.2h7.2l2.6 2.6v7.2a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2z" /><path d="M5.2 2.5v3.6h5.1V2.5M5.2 13.5v-3.8h5.6v3.8" /></>,
  scissors: <><circle cx="4.2" cy="11.8" r="1.7" /><circle cx="4.2" cy="4.2" r="1.7" /><path d="M5.5 10.7 13 3.2M5.5 5.3 13 12.8" /></>,
  undo: <><path d="M3 7.5h7.2a3.3 3.3 0 1 1 0 6.6H6.4" /><path d="M5.7 4.2 2.4 7.5l3.3 3.3" /></>,
  redo: <><path d="M13 7.5H5.8a3.3 3.3 0 1 0 0 6.6h3.8" /><path d="M10.3 4.2l3.3 3.3-3.3 3.3" /></>,
  merge: <><rect x="1.75" y="4.5" width="12.5" height="7" rx="1.2" /><path d="M8 4.5v7" /></>,
  trash: <><path d="M2.75 4.25h10.5M6 4.25V2.9a.9.9 0 0 1 .9-.9h2.2a.9.9 0 0 1 .9.9v1.35" /><path d="M4.2 4.25l.6 8.6a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.6" /></>,
  clock: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.4V8l2.4 1.6" /></>,
  volume: <><path d="M7.5 3.2 4.6 5.7H2.4v4.6h2.2l2.9 2.5z" /><path d="M10.3 6a3 3 0 0 1 0 4M12.3 4.2a5.6 5.6 0 0 1 0 7.6" /></>,
  mute: <><path d="M7.5 3.2 4.6 5.7H2.4v4.6h2.2l2.9 2.5z" /><path d="m10.4 6.4 3.2 3.2M13.6 6.4l-3.2 3.2" /></>,
  fullscreen: <path d="M2.5 6V3.2a.7.7 0 0 1 .7-.7H6M10 2.5h2.8a.7.7 0 0 1 .7.7V6M13.5 10v2.8a.7.7 0 0 1-.7.7H10M6 13.5H3.2a.7.7 0 0 1-.7-.7V10" />,
  eject: <><path d="M8 2.6 3.2 8.4h9.6z" /><path d="M3.4 11.8h9.2" /></>,
  image: <><rect x="1.75" y="3" width="12.5" height="10" rx="1.2" /><circle cx="5.6" cy="6.5" r="1.1" /><path d="m2.4 11.6 3.3-3.1a1 1 0 0 1 1.35 0l2.6 2.4a1 1 0 0 0 1.36 0l1.3-1.2" /></>,
  wave: <path d="M1.6 8h1.5M4.6 5v6M7.1 2.8v10.4M9.6 4.4v7.2M12.1 6.2v3.6M14.4 8h.01" />,
  search: <><circle cx="7.2" cy="7.2" r="4.6" /><path d="m10.6 10.6 3 3" /></>,
  target: <><circle cx="8" cy="8" r="5.2" /><path d="M8 1.4v2.2M8 12.4v2.2M1.4 8h2.2M12.4 8h2.2" /></>,
  download: <><path d="M8 2.6v7.6" /><path d="M4.6 7l3.4 3.4L11.4 7" /><path d="M2.8 13.4h10.4" /></>,
  arrowLeft: <path d="M13 8H3M3 8l4.2-4.2M3 8l4.2 4.2" />,
  arrowRight: <path d="M3 8h10M13 8 8.8 3.8M13 8l-4.2 4.2" />,
  arrowDown: <path d="M8 3v10M8 13l-4.2-4.2M8 13l4.2-4.2" />,
  toEditor: <><path d="M13.4 8H4.8" /><path d="M8.2 4.6 4.8 8l3.4 3.4" /><path d="M2.4 3.4v9.2" /></>,
  more: <><circle cx="3.4" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12.6" cy="8" r=".9" /></>,
  network: <><rect x="2" y="9.5" width="12" height="4.2" rx="1" /><path d="M8 9.5V6.2M4.6 6.2h6.8M4.6 6.2V4M11.4 6.2V4M4.6 11.6h.01M7 11.6h.01" /></>,
}

/** `more` and `star` read better filled; everything else is a stroke. */
const FILLED: IconName[] = ['star']

export default function Icon({
  name, className = '', size = 15, filled,
}: {
  name: IconName
  className?: string
  size?: number
  /** Force the filled variant, e.g. a starred row. */
  filled?: boolean
}) {
  const solid = filled ?? FILLED.includes(name)
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={`inline-block shrink-0 ${className}`}
      fill={solid ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {P[name]}
    </svg>
  )
}
