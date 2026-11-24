// The composer's IME composition state, so the placeholder and editing guards follow an input method session.

import { useEffect, useRef, useState } from 'react';
import { noteRenderer } from './rendererNote';

/** A composition still open this long after it started is noted in the renderer record: an input method that never ended it (#5402). */
export const COMPOSITION_OPEN_MS = 3000;

/** Keep the placeholder and native editing guards in sync throughout an IME session. */
export function useComposerComposition(commit: () => void) {
  const composing = useRef(false);
  const [active, setActive] = useState(false);
  const open = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(open.current), []);
  const start = () => {
    composing.current = true;
    setActive(true);
    clearTimeout(open.current);
    open.current = setTimeout(() => noteRenderer({ what: 'composerComposition', ms: COMPOSITION_OPEN_MS }), COMPOSITION_OPEN_MS);
  };
  const end = () => {
    clearTimeout(open.current);
    composing.current = false;
    setActive(false);
    commit();
  };
  const blur = () => {
    if (composing.current) end();
  };
  return { composing, active, start, end, blur };
}
