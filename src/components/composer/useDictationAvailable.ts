// Whether the composer's Dictate button is shown: false once main says every dictation service is blocked here.
import { useState } from 'react';
import { useEffectOn } from '../../lib/effects';
import { useStore } from '../../store/core';
import { native } from '../../lib/native';
import { ignoring } from '../../lib/ignored';
import type { CapsHint } from '../../store/session/capsTypes';

/**
 * A service that can't be checked keeps the button (its press says what is wrong); main never launches the speech
 * helper for this. Rechecked when settings or accounts change and when the window regains focus; the latest check wins.
 */
export function useDictationAvailable(threadId: string | null, hint: CapsHint | undefined, skip: boolean) {
  const [available, setAvailable] = useState(true);
  const kind = hint?.kind;
  const prefs = useStore((s) => s.prefs);
  const accounts = useStore((s) => s.accounts);
  const claudeAccounts = useStore((s) => s.claudeAccounts);
  // settings and accounts only trigger a new check: main reads them itself
  useEffectOn([threadId, kind, skip, prefs, accounts, claudeAccounts], () => {
    if (skip) return;
    let read = 0;
    const check = () => {
      const mine = ++read;
      void native.speech
        .available(threadId, kind ? { kind } : {})
        .then((yes) => mine === read && setAvailable(yes), ignoring('check whether any dictation service is available'));
    };
    check();
    window.addEventListener('focus', check);
    return () => {
      read = -1;
      window.removeEventListener('focus', check);
    };
  });
  return available;
}
