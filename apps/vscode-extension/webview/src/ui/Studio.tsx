import type { ReactNode } from "react";

/**
 * Pieces of the Studio design (Figma Make "Jesutobits AI Coding Workspace"): its line icons,
 * the pixel "J" and Buddy. Colours come from theme tokens and `currentColor` only.
 */
const GLYPHS: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  play: <path d="M8 5v14l11-7z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  leaf: <path d="M20 3C8 2 2 9 6 16s16 1 14-13ZM5 21l11-13" />,
  settings: (
    <>
      <path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.9-.7-1.3-.7-2.2 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4c0-4.7-4-8.6-9-8.6z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10" cy="7" r="1" />
      <circle cx="15" cy="7.5" r="1" />
    </>
  ),
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18" />,
  chat: <path d="M5 4h14a2 2 0 0 1 2 2v11H8l-5 4V6a2 2 0 0 1 2-2z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="4" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  book: <path d="M12 6C8 3 3 4 3 4v15s5-1 9 2c4-3 9-2 9-2V4s-5-1-9 2v15" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
    </>
  ),
  inspect: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5M9 9l4 11 2-5 5-2z" />,
  reload: <path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6" />,
  external: <path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
};

export type GlyphName = keyof typeof GLYPHS;

export function Glyph({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {GLYPHS[name]}
    </svg>
  );
}

/** The pixel "J" on a soft tile, in the accent colour. */
export function JMark({ size = 22 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md bg-accent-subtle text-accent"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" width={size - 2} height={size - 2}>
        <path d="M8 6h18v6h-5v14H9v-5H4v-7h6v6h5v-8H8z" fill="currentColor" />
      </svg>
    </span>
  );
}

/** OpenRouter's mark (from openrouter.ai), for "Sign in with OpenRouter"; inherits the colour. */
export function OpenRouterMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="19.82 17.199 365.556 258.298"
      width={size * 1.4}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M303.9475,17.19926c42.79734,0,77.48933,34.69327,77.48933,77.48933s-34.69199,77.48933-77.48933,77.48933l76.86166,76.86244c9.76367,9.76313,2.84903,26.45667-10.95697,26.45667h-220.88335c-71.32686,0-129.14889-57.82202-129.14889-129.14889S77.64197,17.19926,148.96884,17.19926h154.97866ZM148.96884,68.85881c-42.79607,0-77.48933,34.69327-77.48933,77.48933s34.69327,77.48933,77.48933,77.48933,77.48933-34.69327,77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z" />
    </svg>
  );
}

/** Buddy, the co-builder (styles/studio.css draws it). */
export function Buddy({ className = "", kind }: { className?: string; kind?: string }) {
  return (
    <div className={`buddy ${className}`} data-kind={kind} aria-hidden="true">
      <div className="buddy-antenna" />
      <div className="buddy-face">
        <i />
        <i />
        <span />
      </div>
      <div className="buddy-feet">
        <i />
        <i />
      </div>
      <div className="buddy-orbit" />
      <span className="buddy-star">+</span>
      <span className="buddy-star star-two">+</span>
    </div>
  );
}
