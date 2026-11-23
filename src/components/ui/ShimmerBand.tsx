// A shimmering label (.shimmer-text, .shimmer) and its highlight band: an empty layer the label's glyphs mask, swept by a composited translate.
import { useState, type CSSProperties, type ReactNode } from 'react';

/** One sweep of the band (shimmer-band in src/styles/app/motion.css). */
export const SHIMMER_SWEEP_MS = 3000;
/** Where a cadenced `.shimmer` label's first sweep starts after it appears (shimmer-cadence in src/styles/app/motion.css). */
export const CADENCE_FIRST_SWEEP_MS = 600;

/**
 * The band a shimmering label sweeps (src/styles/app/motion.css). It starts on the phase of a clock every band
 * shares, so rows that begin apart sweep together and a label that remounts (a title crossfading in) resumes
 * mid-sweep instead of jumping back to the start, as Claude Desktop's ShimmerText keeps its sweep's start time. The
 * phase is read once: a delay that changed on a later render would shift the running sweep. A cadenced `.shimmer` label
 * (Codex's, a sweep every 4 s from 600 ms after it appears) is not on that clock: a band that remounts with `since`, the
 * time its label first appeared, resumes the cadence where the label's own timeline has it.
 */
export function ShimmerBand({ since }: { since?: number }) {
  const [style] = useState(() => {
    const now = performance.now();
    const vars: Record<string, string> = { '--shimmer-delay': `${-Math.round(now % SHIMMER_SWEEP_MS)}ms` };
    if (since !== undefined) vars['--shimmer-resume'] = `${CADENCE_FIRST_SWEEP_MS - Math.round(now - since)}ms`;
    return vars as CSSProperties;
  });
  return <span className="shimmer-band" aria-hidden style={style} />;
}

/** What a label says, as one string, when its words are text only (a string, a number, or a run of them: JSX `Running {cmd}`). */
function wordsKey(children: ReactNode): string | undefined {
  const parts = Array.isArray(children) ? children : [children];
  return parts.every((p) => typeof p === 'string' || typeof p === 'number') ? parts.join('') : undefined;
}

/**
 * A label that shimmers: its words with the band they sweep, in the element class `className` and the shimmer class
 * (`.shimmer-text` by default). The words are the element's key, so a new label is a new element. The glyph mask
 * (`mask-clip: text`) of an element whose words changed in place kept the glyph shapes of the old words, and the new words
 * showed only where those shapes were: "Checking whether the Cafe 36…" came out as a smear after its first words (#4654). A new
 * element paints a fresh mask, and the sweep carries on across the change: the band's phase comes from the shared clock,
 * or for a cadenced label from the time its first words appeared. Words that hold a node have no key and keep their element.
 */
export function ShimmerSpan({
  className,
  shimmer = 'shimmer-text',
  on = true,
  children,
}: {
  className?: string;
  shimmer?: string;
  on?: boolean;
  children: ReactNode;
}) {
  // when the label first appeared: the cadenced sweep's timeline outlives each new element
  const [since] = useState(() => performance.now());
  const classes = on ? (className ? `${className} ${shimmer}` : shimmer) : className;
  return (
    <span key={wordsKey(children)} className={classes}>
      {children}
      {on && <ShimmerBand since={since} />}
    </span>
  );
}
