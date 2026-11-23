// What Up next reads and does about MoMo's suggestions (A7), apart from how it looks: the live list from main (electron/momo/suggestions.cjs), read again on a change main tells and every few seconds, and the user's own Add, Start and Hide. A failed read keeps the last list known and shows nothing new; nothing is shown while MoMo is not allowed or the panel is off. Start is the user's press: it sends the suggestion's first step to MoMo's chat, and a refusal says why in a toast and leaves the suggestion where it was.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import type { MomoSuggestion, MomoSuggestionAction } from '../../../lib/native/contracts/momoSuggestions';
import { toast } from '../../../store/core';
import { navigate } from '../../../store/panes';
import { visiblePoll } from '../../../lib/visiblePoll';
import { errorText, noteIgnored } from '../../../lib/ignored';
import { REFRESH_MS } from './useTaskPanel';

export type SuggestionsView = { suggestions: MomoSuggestion[]; shown: number };

export function useSuggestions(every = REFRESH_MS) {
  const [view, setView] = useState<SuggestionsView | null>(null);
  /** the ones the user just added in this window: their row slides up once (motion, design 6) */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await native.momoSuggestions.list();
      if (mine !== seq.current) return;
      if (r.ok) setView({ suggestions: r.suggestions, shown: r.shown });
      else if (r.reason === 'not_allowed' || r.reason === 'unavailable') setView(null);
    } catch (error) {
      // the last list stays: the tasks panel already says when its own read fails
      noteIgnored('read MoMo’s suggestions', error);
    }
  }, []);
  useEffect(() => {
    void load();
    const stop = native.momoSuggestions.onChanged(() => void load());
    const stopPoll = visiblePoll('momo-suggestions', every, () => void load());
    return () => {
      seq.current++;
      stopPoll();
      stop();
    };
  }, [load, every]);

  /** The user's Add, Start or Hide on one; Start goes on to MoMo's chat. */
  const act = useCallback(
    async (id: string, action: MomoSuggestionAction) => {
      try {
        const r = await native.momoSuggestions.act(id, action);
        if (!r.ok) toast(r.reason === 'gone' ? 'That suggestion is gone.' : r.error, 'error');
        else if (action === 'add') setFresh((s) => new Set(s).add(id));
        else if (action === 'start') navigate({ name: 'momo', tab: 'chat' });
      } catch (e) {
        toast(errorText(e), 'error');
      }
      await load();
    },
    [load],
  );
  return { view, fresh, act, load };
}
