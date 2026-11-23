// The seam over the main process: `window.native.momoHome` (electron/bridge/momoHome.cjs). Every answer is parsed before the store sees it (parseView.ts); the view changes only from what the home sends back, never from a move this client made.
import type { NativeApi } from '../../../lib/native';
import { toIntent } from './homeIntents';
import { setHomeNotice } from './homeNotice';
import type { MomoHomeSeam } from './homeSeam';
import { parseIntentAnswer, parseViewAnswer } from './parseView';
import { believe, currentHomeName, forgetLease } from './stampStore';
import { clearStale, noteStale } from './staleNote';

/** What is said of an answer from a home MoMo has moved away from. */
const staleCause = () => `MoMo runs on ${currentHomeName() ?? 'another machine'} now.`;

export function createIpcSeam(bridge: NativeApi['momoHome']): MomoHomeSeam {
  const listeners = new Set<(v: Parameters<Parameters<MomoHomeSeam['subscribe']>[0]>[0]) => void>();
  let off: (() => void) | null = null;
  /** The view if this window may believe it; a view from a home older than the newest seen is dropped and noted. */
  const trusted = (answer: ReturnType<typeof parseViewAnswer>) => {
    if (!answer.ok) return answer;
    const view = believe(answer.view);
    if (view) {
      clearStale();
      return { ok: true as const, view };
    }
    noteStale();
    return { ok: false as const, cause: staleCause() };
  };
  const fan = (answer: ReturnType<typeof parseViewAnswer>) => {
    const t = trusted(answer);
    if (t.ok) for (const l of listeners) l(t.view);
    return t;
  };
  return {
    read: async () => {
      try {
        return trusted(parseViewAnswer(await bridge.view()));
      } catch {
        return { ok: false, cause: 'MoMo’s home didn’t answer.' };
      }
    },
    subscribe(cb) {
      listeners.add(cb);
      off ??= bridge.onChanged((payload) => fan(parseViewAnswer(payload)));
      return () => {
        listeners.delete(cb);
        if (!listeners.size) {
          off?.();
          off = null;
        }
      };
    },
    async act(a) {
      try {
        const r = parseIntentAnswer(await bridge.intent(toIntent(a)));
        if (!r.ok) return r;
        // choosing where MoMo lives makes a new home, which starts again at its first lease
        if (a.type === 'setup.choose') forgetLease();
        // an answer whose view this window just refused as stale did not happen here: it is a failure, with where MoMo runs
        if (r.view) {
          const t = fan({ ok: true, view: r.view });
          if (!t.ok) return { ok: false, cause: t.cause };
        }
        if (r.notice) setHomeNotice(r.notice);
        return { ok: true, ...(r.notice ? { notice: r.notice } : {}) };
      } catch {
        return { ok: false, cause: 'MoMo’s home didn’t answer.' };
      }
    },
  };
}
