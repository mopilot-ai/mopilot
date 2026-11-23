// Settings › Superagent: the page's state from main, refreshed when main says something changed, and a way to make a change that shows a refusal as a toast.
import { useCallback, useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { toast } from '../../store/core';
import type { SuperagentState } from '../../lib/native/superagent';

export function useSuperagent() {
  const [state, setState] = useState<SuperagentState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await native.superagent.state());
      setFailure(null);
    } catch (e) {
      setFailure(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    return native.superagent.onChanged(() => void load());
  }, [load]);

  /** Runs a change, then reads the state again; a refusal (a bad repo, a bad login) is told in a toast and the page stays as it was. Resolves whether it went through. */
  const change = useCallback(
    async (run: () => Promise<unknown>): Promise<boolean> => {
      try {
        await run();
        await load();
        return true;
      } catch (e) {
        toast(errorText(e), 'error');
        return false;
      }
    },
    [load],
  );

  return { state, failure, change };
}
