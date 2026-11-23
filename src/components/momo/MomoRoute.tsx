// The momo route's slot in the main window, mounted with the app whatever the page or sidebar: ⌘. (Ctrl+. elsewhere) opens MoMo, and its page loads, only once main says the account was invited; when main says no (never invited, revoked, signed out), the window goes back to a new chat and MoMo leaves the history.
import { lazy, Suspense, useEffect } from 'react';
import { useMomoAccess } from '../../lib/momo';
import { modKey } from '../../lib/platform';
import { get as getState, set as setState } from '../../store/core';
import { navigate } from '../../store/panes';
import type { Route } from '../../store/route';

const MomoPage = lazy(() => import('./MomoPage'));

/** ⌘. or Ctrl+. alone (⇧⌘. stays the browser's comment mode), unless another handler took it first. */
export function isMomoKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'>) {
  return e.key === '.' && modKey(e) && !e.shiftKey && !e.altKey && !e.defaultPrevented;
}

const notMomo = (r: Route) => r.name !== 'momo';

export function MomoRoute({ route }: { route: Route }) {
  const { allowed, known } = useMomoAccess();
  const here = route.name === 'momo';
  useEffect(() => {
    if (!allowed) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isMomoKey(e)) return;
      e.preventDefault();
      navigate({ name: 'momo' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allowed]);
  useEffect(() => {
    if (!known || allowed) return;
    if (here) navigate({ name: 'home' });
    // Back and Forward never lead into MoMo again (each would only bounce off this redirect)
    const s = getState();
    if (s.back.some((r) => !notMomo(r)) || s.forward.some((r) => !notMomo(r)))
      setState({ back: s.back.filter(notMomo), forward: s.forward.filter(notMomo) });
  }, [here, known, allowed]);
  if (!here || !allowed) return null;
  return (
    <Suspense fallback={null}>
      <MomoPage tab={route.tab} chatId={route.chatId} />
    </Suspense>
  );
}
