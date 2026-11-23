// What a welcome page row says under itself (#2034): a failed step, or what a re-check found, kept across the row's
// Checking… and dropped once it moves on; a toast where there is no row, or no longer one.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { toast } from '../../store/core';
import { errorText } from '../../lib/ignored';
import { useEffectOn } from '../../lib/effects';
import type { SetupNeed } from '../../lib/welcome';
import type { Say } from '../../session/harness/claude/accounts';

/** What a row says under itself: a failed step (#2034), or what a re-check found. */
export type Said = { error: boolean; text: string } | null;
/** Where a row's words go (a failure is a toast where there is no row, or no longer one), and its settled state. */
type Row = { say: (said: Said) => void; settled: () => SetupNeed | null };
const toastFailed = (said: Said) => said?.error && toast(said.text, 'error');
export const RowContext = createContext<Row>({ say: toastFailed, settled: () => null });

/** Runs a step the user asked for; one that fails says why under its row. */
export function useRun() {
  const { say } = useContext(RowContext);
  return (fn: () => Promise<unknown>): void => {
    fn().catch((e) => say({ error: true, text: errorText(e) }));
  };
}

/** Re-check: what the harness found is said under the row (#2034), or `still` while the row is where it was. The row
 * says it, not this: a check passes through Checking…, which unmounts the part of the row that asked. */
export function useRecheck(check: (say: Say) => Promise<unknown>, still: string) {
  const row = useContext(RowContext);
  const run = useRun();
  return () =>
    run(async () => {
      let spoke = false;
      const from = row.settled();
      row.say(null);
      await check((text, kind) => {
        spoke = true;
        row.say({ error: kind === 'error', text });
      });
      // a row that moved on (found, signed in) says so itself
      if (!spoke && row.settled() === from) row.say({ error: false, text: still });
    });
}

/** A row's words and its context: what was said stands while the row passes through Checking…, and goes once it moves on. */
export function useRowSays(need: SetupNeed) {
  const [said, setSaid] = useState<Said>(null);
  const settled = useRef(need);
  if (need !== 'checking') settled.current = need;
  useEffectOn([settled.current], () => {
    setSaid(null);
  });
  // a step that ends after the page closed says its failure in a toast
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const [row] = useState<Row>(() => ({
    say: (x) => (shown.current ? setSaid(x) : toastFailed(x)),
    settled: () => settled.current,
  }));
  return [said, row] as const;
}
