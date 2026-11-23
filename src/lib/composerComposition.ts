// The composer's IME composition state, so the placeholder and editing guards follow an input method session.

import { useRef, useState } from 'react';

/** Keep the placeholder and native editing guards in sync throughout an IME session. */
export function useComposerComposition(commit: () => void) {
  const composing = useRef(false);
  const [active, setActive] = useState(false);
  const start = () => {
    composing.current = true;
    setActive(true);
  };
  const end = () => {
    composing.current = false;
    setActive(false);
    commit();
  };
  const blur = () => {
    if (composing.current) end();
  };
  return { composing, active, start, end, blur };
}
