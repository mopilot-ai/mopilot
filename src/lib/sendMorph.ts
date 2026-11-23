// The composer's send / stop / voice button morph: which of the Codex app's transitions plays when it changes.
import { useState } from 'react';

/** What the composer's round button does now. */
export type SendButtonState = 'send' | 'stop' | 'voice';
/** The Codex composer's four button transitions (toStop, stopToSend, voiceToSend, toVoice). */
export type SendMorph = 'to-stop' | 'stop-to-send' | 'voice-to-send' | 'to-voice';

/** The transition from one button state to the next; none when nothing changed. */
export function sendMorph(from: SendButtonState, to: SendButtonState): SendMorph | null {
  if (from === to) return null;
  if (to === 'stop') return 'to-stop';
  if (to === 'voice') return 'to-voice';
  return from === 'stop' ? 'stop-to-send' : 'voice-to-send';
}

/** The glyph's longest animation per transition (composer.css): when it ends, the transition is over. */
const LAST = /^send-(turn|wobble)-/;

/**
 * The transition the button plays: set when its state changes and kept while it plays, so a re-render in between
 * does not cut it short, then cleared (`onAnimationEnd`, on the button), so a glyph swapped later without a change
 * of state (voice on and off) does not replay it. The first render plays none.
 */
export function useSendMorph(state: SendButtonState): {
  morph: SendMorph | null;
  onAnimationEnd: (e: { animationName: string }) => void;
} {
  const [seen, setSeen] = useState<{ state: SendButtonState; morph: SendMorph | null }>({ state, morph: null });
  const onAnimationEnd = (e: { animationName: string }) => {
    if (LAST.test(e.animationName)) setSeen((s) => ({ state: s.state, morph: null }));
  };
  if (seen.state === state) return { morph: seen.morph, onAnimationEnd };
  // React's "store information from previous renders" pattern: update during render, before the commit
  const morph = sendMorph(seen.state, state);
  setSeen({ state, morph });
  return { morph, onAnimationEnd };
}
