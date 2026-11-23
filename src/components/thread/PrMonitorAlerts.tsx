// Auto-fix news the user must act on, told wherever the chat shows: the Changes card that holds the PR's rows is hidden
// while another pane is open, so a fix that may not have reached the chat, or one that ran out of tries, says so once.
import { useEffect } from 'react';
import { native } from '../../lib/native';
import type { PrMonitorState } from '../../lib/native/prMonitor';
import { toast } from '../../store/core';
import { prNumber, usePrMonitor, type PrMonitorApi } from './usePrMonitor';

/** Each flag's news, and what it says of a continuation instead. */
const NEWS: [keyof Pick<PrMonitorState, 'uncertain' | 'limited'>, string, string][] = [
  ['uncertain', 'Auto-fix may not have reached the chat', 'Continuation may not have reached the chat'],
  ['limited', 'Auto-fix stopped after several tries', 'Auto-fix stopped after several tries'],
];

/** What this window has told, by chat, PR and kind: a chat opened again does not repeat it until it clears and returns. */
const told = new Set<string>();

/** Toasts each piece of Auto-fix news once, with Retry; renders nothing. */
export function PrMonitorAlerts({ chatId, api = native.prMonitor }: { chatId: string; api?: PrMonitorApi }) {
  const { state, mutate } = usePrMonitor(chatId, api);
  useEffect(() => {
    if (!state) return;
    for (const [flag, text, continued] of NEWS) {
      const key = `${chatId}\n${state.url}\n${flag}`;
      if (!state[flag]) told.delete(key);
      else if (!told.has(key)) {
        told.add(key);
        toast(`${state.continuation ? continued : text} (#${prNumber(state.url)})`, 'error', {
          action: { label: 'Retry', run: () => void mutate({ retry: true }) },
        });
      }
    }
  });
  return null;
}
