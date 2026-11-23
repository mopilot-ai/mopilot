// The machine chat kit's rig: fake sessions that keep what they were sent, phones that answer, and a card store, with the kit made over them.
import { createHostChatKit, facade } from '../../../mobile/src/remote/hostChat.ts';
import { createCardStore } from '../../../mobile/src/remote/hostCards.ts';

export function rig(
  o: {
    up?: boolean;
    sendError?: () => Error | null;
    pending?: any[];
    answerError?: any;
    refreshFails?: boolean;
    /** The agents the Host reports, as the phone's own list gives them. */
    agents?: object[];
    /** What chat.switch answers with (a move held: its pending). */
    switchError?: () => Error | null;
    start?: (p: any) => unknown;
  } = {},
) {
  const sent: any[] = [];
  /** The switches and permission modes the Host was asked for. */
  const moves: any[] = [];
  const permits: any[] = [];
  /** The agent the chat under test was started on, so a move to it reads as taking the choice back. */
  let chatStartedOn = '';
  let up = o.up ?? true;
  let changes = 0;
  let n = 0;
  const session = {
    subscribe: async (p: any) => {
      kit.chats.onEvent('m1', {
        event: 'frame',
        chatId: p.chatId,
        frame: { t: 'hello', seq: 0, rev: 0, epoch: 1, generation: 'g', snapshot: { rev: 0, items: [] }, inFlightEphemeral: [] },
      });
      return {};
    },
    send: async (p: any) => {
      const error = o.sendError?.();
      if (error) throw error;
      sent.push(p);
      return {};
    },
    stop: async (p: any) => (sent.push(p), { stopped: true }),
    switchTo: async (p: any) => {
      const error = o.switchError?.();
      if (error) throw error;
      moves.push(p);
      // the reply as the Host's connection hands it over: the envelope around the effect's result
      return { replayed: false, result: { pending: p.harness === 'claude' && chatStartedOn === 'claude' ? null : { harness: p.harness } } };
    },
    permit: async (p: any) => (permits.push(p), { replayed: false, result: { permission: p.value } }),
    start: async (p: any) => {
      await o.start?.(p);
      return sent.push(p), { chatId: p.chatId };
    },
  };
  const cards = createCardStore();
  const answers: any[] = [];
  /** The form each answer carried (a question's), in order. */
  const forms: unknown[] = [];
  const phones: any = {
    refresh: async () => (o.refreshFails ? false : (cards.setPending('k', o.pending ?? []), true)),
    answer: async (m: string, name: string, cardId: string, optionId: string, failure: any, answered: any, form?: unknown) => {
      answers.push([m, name, cardId, optionId]);
      forms.push(form);
      if (o.answerError) failure(o.answerError, name, optionId);
      else answered('allow');
    },
    agents: () => o.agents ?? null,
    session: async () => session,
    hostKeyOf: () => 'k',
    enrolled: (m: string) => m === 'm1',
    reachable: () => up,
  };
  const kit = createHostChatKit({ phones: () => phones, cards, newId: () => `id${++n}`, changed: () => void changes++ });
  const base: any = {
    snapshot: () => ({ outbox: [{ id: 'mac1', pairId: 'p', chatId: 'c1' }], selectedPair: 'p' }),
    subscribe: () => () => undefined,
    onEvent: (fn: (e: any) => void) => {
      macFeed.push(fn);
      return () => void macFeed.splice(macFeed.indexOf(fn), 1);
    },
    request: async (method: string) => `mac:${method}`,
    cancelSend: (id: string) => id === 'mac1',
    editSend: (id: string) => id === 'mac1',
    retrySend: (id: string) => id === 'mac1',
    direct: 'the-direct',
  };
  const macFeed: any[] = [];
  return {
    kit,
    phones,
    base,
    sent,
    macFeed,
    setUp: (v: boolean) => (up = v),
    changes: () => changes,
    runtime: facade(base, kit, 'm1', 'Studio', phones),
    cards,
    answers,
    forms,
    moves,
    permits,
    startedOn: (harness: string) => void (chatStartedOn = harness),
  };
}
