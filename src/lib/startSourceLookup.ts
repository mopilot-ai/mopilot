// The branch menu's GitHub lookup: the pull request or issue that `#12`, or either's link, typed in its search names in the folder's origin repository.
import { useEffect, useState } from 'react';
import { native } from './native';
import type { StartSource } from './native/git';
import { errorText, noteIgnored } from './ignored';
import { startRef } from '../../shared/startRef.mjs';

/** How long typing must pause before GitHub is asked, so each keystroke of a link is not a lookup. */
export const LOOKUP_DELAY_MS = 300;

/** Whether Linear is connected, read when `open` turns true (the branch menu opening): until then, not. */
export function useLinearConnected(open: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    native.linear.status().then(
      (s) => live && setOn(s.connected),
      (error) => noteIgnored('read whether Linear is connected', error),
    );
    return () => {
      live = false;
    };
  }, [open]);
  return on;
}

export type StartLookup =
  | { state: 'none' }
  /** what is being looked up, as typed: #12 or ENG-12 */
  | { state: 'looking'; label: string }
  | { state: 'found'; found: Extract<StartSource, { ok: true }> }
  | { state: 'failed'; error: string };

/**
 * `none` unless `text` names a pull request or issue (and `cwd` is set); else the lookup, after a pause in typing. An
 * answer for text since changed, or for a menu since closed, is dropped: what shows is always for what is typed now.
 * A Linear key (ENG-12) is one only while Linear is connected (`linear`): else it is a branch name like any other.
 */
export function useStartLookup(cwd: string | null, text: string, linear = false): StartLookup {
  const named = cwd ? startRef(text) : null;
  const ref = named?.kind === 'linear' && !linear ? null : named;
  // the text as it is asked about: null when it names nothing to start from, so nothing is looked up
  const asked = ref ? text.trim() : null;
  const key = asked === null ? null : `${cwd}\n${asked}`;
  const [answer, setAnswer] = useState<{ key: string; lookup: StartLookup } | null>(null);
  useEffect(() => {
    if (asked === null || !cwd) return;
    const own = `${cwd}\n${asked}`;
    let live = true;
    const timer = setTimeout(() => {
      native.git.startSource(cwd, asked).then(
        (r) => live && setAnswer({ key: own, lookup: r.ok ? { state: 'found', found: r } : { state: 'failed', error: r.error } }),
        (e) => live && setAnswer({ key: own, lookup: { state: 'failed', error: errorText(e) } }),
      );
    }, LOOKUP_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cwd, asked]);
  if (!ref || !key) return { state: 'none' };
  return answer?.key === key ? answer.lookup : { state: 'looking', label: ref.kind === 'linear' ? ref.key : `#${ref.number}` };
}
