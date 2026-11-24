// The world of the notice-learning tests: the notice lane's store as the real notice intents see it (its decision log, its matters, its reactions), the real learning service beside it, and a tap that is followed by the learning service looking at what the lane recorded.
import { createNoticeIntents } from '../../../host/src/momoNoticeIntents.mjs';
import { world } from './momoCoreWorld.ts';

export /** The notice lane's store as the real intents see it: its decision log, its matters, its reactions. */
async function noticing(t: any, extra: object = {}) {
  const w = await world(t, extra);
  let tick = 1_000;
  const reactions: any[] = [];
  const decisions: any[] = ['a1', 'a2', 'a3', 'b1'].map((id) => ({
    changeId: `gmail:${id}`,
    matterKey: id,
    decidedBy: 'model:x',
    outcome: 'told',
    senderStatus: 'pass',
    // the sender of the mail that was judged, on the decision itself (never read from the matter, which keeps the first sender)
    fromDomain: id.startsWith('a') ? 'acme.com' : 'shop.example',
    fromAddress: null,
    at: 500,
  }));
  const matters: Record<string, any> = Object.fromEntries(
    decisions.map((d) => [
      d.matterKey,
      {
        state: 'open',
        fromDomain: d.matterKey.startsWith('a') ? 'acme.com' : 'shop.example',
        updatedAt: new Date(0).toISOString(),
        sources: [],
        title: 'T',
      },
    ]),
  );
  const store: any = {
    decisions: () => decisions,
    // each reaction gets the store's id and the next sequence number, as the real store gives it (a reaction a test pushes straight in is numbered when it is first read)
    reactions: () => {
      for (const r of reactions) if (r && typeof r === 'object' && !('seq' in r)) Object.assign(r, { store: store.id, seq: ++store.seq });
      return reactions;
    },
    addReaction: async (r: any) => void reactions.push({ ...r, store: store.id, seq: ++store.seq }),
    id: 'store-1',
    seq: 0,
    notice: {
      getMatter: async (k: string) => matters[k],
      // the matter is let go atomically on the record as it is now, once
      updateMatter: async (k: string, fn: (m: any) => any) => {
        const next = fn(matters[k]);
        if (next) Object.assign(matters[k], next);
        return !!next;
      },
    },
  };
  const intents: any = createNoticeIntents({
    store,
    home: { prefs: { change: async () => undefined } } as any,
    now: () => w.clock.at + ++tick,
    signalIds: () => w.learning.view().signals.map((s: any) => s.id),
  });
  w.home.provide('notice', { reactions: () => store.reactions(), intents });
  const rules = () => w.learning.view().rules;
  // the owner's brief is on (it is off until they turn it on); a test of the brief being off says so itself
  await w.home.prefs.change({ brief: { on: true } });
  return { w, reactions, decisions, intents, store, matters, rules, learning: w.learning };
}
/** A tap on a notice, and the learning service looking at what the notice lane recorded. */
export const tap = async (n: any, id: string) => {
  await n.intents['row.notNeeded']({ rowId: `gmail:${id}`, decisionId: `gmail:${id}@500` });
  n.w.clock.at += 10;
  return n.learning.consumeNotices();
};
