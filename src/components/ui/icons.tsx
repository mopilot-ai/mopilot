// The app's icons: lucide-react re-exported, plus custom marks and glyphs.

import type { CSSProperties, SVGProps } from 'react';
import { MessageCirclePlus, type LucideProps } from 'lucide-react';
import { MARKS, PYTHON_LOGO } from '../../lib/brandColors';
export * from 'lucide-react';

/** Side chat glyph: a plus speech bubble with its tail on the right, as in the official app. */
export function SideChatIcon({ style, ...p }: LucideProps) {
  return <MessageCirclePlus {...p} style={{ transform: 'scaleX(-1)', ...style }} />;
}

/** Codex "cloud with prompt" mark used on the new-chat hero. */
export function CodexMark({ size = 56, ...p }: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none" {...p}>
      <path
        d="M28 6.5c4.1 0 7.6 2.3 9.4 5.7 4.6-.5 8.9 2.6 9.9 7.2.9 4-1 7.9-4.3 9.8 1.6 4.3-.1 9.2-4.2 11.5-3 1.7-6.5 1.6-9.3.2-1.7 3.3-5.2 5.6-9.2 5.4-4.6-.2-8.3-3.7-8.9-8.1-4.4-.6-7.8-4.4-7.7-9 0-3.5 2.1-6.6 5.1-8-1-4.6 1.6-9.2 6.1-10.6 1.6-.5 3.3-.5 4.9-.1C21.4 8 24.5 6.5 28 6.5Z"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path d="m19.5 23 5 4.5-5 4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M28.5 33h8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

// MoPilot's own mark: an orange >_ on a dark rounded square, as in build/icon.png and the website logo.
export function MoPilotMark({ size = 56, ...p }: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" {...p}>
      <rect
        x="1"
        y="1"
        width="98"
        height="98"
        rx="22"
        fill={MARKS.mopilot.tile}
        stroke={MARKS.mopilot.edge}
        strokeOpacity="0.14"
        strokeWidth={size < 32 ? 3 : 1.5}
      />
      <path
        d="M28 34 L44 50 L28 66 M52 66 H70"
        fill="none"
        stroke={MARKS.mopilot.glyph}
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GithubMark({ size = 16, ...p }: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...p}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Voice-mode waveform glyph shown inside the blue round button. */
export function Waveform({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <rect x="1.5" y="6" width="1.6" height="4" rx=".8" />
      <rect x="4.6" y="3.5" width="1.6" height="9" rx=".8" />
      <rect x="7.7" y="1.5" width="1.6" height="13" rx=".8" />
      <rect x="10.8" y="4.5" width="1.6" height="7" rx=".8" />
      <rect x="13.4" y="6.5" width="1.4" height="3" rx=".7" />
    </svg>
  );
}

/** Codex's loading ring: a three-quarter arc over a faint track, in a 24-unit icon box. */
export function Spinner({ size = 14, still = false }: { size?: number; still?: boolean }) {
  return (
    <svg className={still ? 'spinner still' : 'spinner'} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeOpacity=".3" strokeWidth="2" />
      <path d="M12 5a7 7 0 1 1-7 7" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** A waiting step's marker: a dotted ring on Spinner's geometry, so the two sit still as a step starts. */
export function DottedRing({ size = 14 }: { size?: number }) {
  return (
    <svg className="dotted-ring" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="1.5 4" />
    </svg>
  );
}

/** Three dots that hop in sequence: a turn thinking, with nothing concrete to report yet. */
export function ThinkingDots({ size = 6 }: { size?: number }) {
  return (
    <span className="thinking-dots" style={{ '--dot-size': `${size}px` } as CSSProperties} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/** Pinned-summary toggle glyph (two bullets with lines). */
export function SummaryIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="5.2" cy="6" r="2.2" />
      <circle cx="5.2" cy="14" r="2.2" />
      <path d="M10.5 6h6.5M10.5 14h6.5" />
    </svg>
  );
}

/** Shield with a prompt glyph, used for "Approve for me". */
export function ShieldTerminal({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 2.2 3.6 4.6v5c0 4 2.7 6.9 6.4 8.2 3.7-1.3 6.4-4.2 6.4-8.2v-5L10 2.2Z" />
      <path d="m7.4 8.2 2.1 1.9-2.1 1.9" />
      <path d="M10.8 12.3h2.4" />
    </svg>
  );
}

/** ± inside a rounded square: the official "changes" glyph (tab, card, summary). */
export function DiffSquare({ size = 16, strokeWidth = 1.6 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round">
      <rect x="4" y="3.5" width="16" height="17" rx="3" />
      <path d="M12 7.5v6M9 10.5h6M9 16.5h6" />
    </svg>
  );
}

/** Python logo (two-tone), used as the .py file icon like the official file lists. */
export function PythonLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path
        fill={PYTHON_LOGO.blue}
        d="M11.9 2C7 2 7.3 4.1 7.3 4.1v2.2h4.7V7H5.5S2 6.6 2 11.9s3 5.1 3 5.1h1.8v-2.5s-.1-3 3-3h4.6s2.9.1 2.9-2.8V4.9S17.7 2 11.9 2zM9.3 3.6a.9.9 0 110 1.8.9.9 0 010-1.8z"
      />
      <path
        fill={PYTHON_LOGO.yellow}
        d="M12.1 22c4.9 0 4.6-2.1 4.6-2.1v-2.2H12V17h6.5s3.5.4 3.5-4.9-3-5.1-3-5.1h-1.8v2.5s.1 3-3 3H9.6s-2.9-.1-2.9 2.8v3.8S6.3 22 12.1 22zm2.6-1.6a.9.9 0 110-1.8.9.9 0 010 1.8z"
      />
    </svg>
  );
}
