// The multi-agent block of the matrix: six chats at once on one Host, mixed across the harnesses this machine can run, two clients on each, one client dropped and returned mid-turn. Each chat gets its own reply and card; no chat's record carries another's marker.
import { expect } from '../steps.mjs';
import { answerCard, eventOf, framesOf, optionOf, waitCard } from '../milestones/common.mjs';
import { available, awaitReply, fileIs, mark, startChat, turnEnd, watch } from './common.mjs';

const CHATS = 6;
/** The chat whose second client leaves while the turn waits and returns after the answer. */
const DROPPED = 2;

export const MULTI_STEP = {
  id: 'multi/six',
  title: 'Matrix multi-agent: six chats at once across the harnesses, two clients each, one client dropped and returned',
  /** @param {any} ctx */
  async run(ctx) {
    const plans = await available(ctx);
    /** @type {{ key: string, t: any, marker: string, a: any, id: string, b: any, card?: any }[]} */
    const chats = [];
    try {
      // start them together: every chat is on the Host at the same time
      const started = await Promise.all(
        Array.from({ length: CHATS }, async (_, k) => {
          const { key, t } = plans[k % plans.length];
          const marker = mark(ctx);
          const { c, id } = await startChat(ctx, t, t.w.approveWith(t.scratch, marker));
          return { key, t, marker, a: c, id, b: await watch(ctx, id) };
        }),
      );
      chats.push(...started);
      for (const chat of chats) chat.card = await waitCard(chat.a, chat.id);
      // waitCard finds a chat's card by its chat id, so a card is never another chat's; two chats must still not share one request
      expect(new Set(chats.map((x) => x.card.requestId)).size === CHATS, 'Two chats share a card request.');
      // one watching client leaves while its chat waits
      const dropped = chats[DROPPED];
      dropped.b.close();
      await Promise.all(chats.map((x) => answerCard(x.a, x.card, optionOf(x.card, 'allow').optionId, `six-${x.id}`)));
      await Promise.all(chats.map((x) => turnEnd(x.a, x.id, x.t.w.waitMs)));
      dropped.b = await watch(ctx, dropped.id);
      await Promise.all(chats.map((x) => turnEnd(x.b, x.id, x.t.w.waitMs)));
      for (const x of chats) {
        const effect = x.t.w.effect(x.t.scratch, x.marker);
        if (effect) await fileIs(ctx, effect, true);
        // the summary item trails the turn's end
        await Promise.all([x.a, x.b].map((client) => awaitReply(client, x.id, '')));
        for (const client of [x.a, x.b]) {
          const seen = JSON.stringify(framesOf(client, x.id));
          for (const other of chats)
            if (other !== x) expect(!seen.includes(other.marker), `${x.key} chat ${x.id} carries ${other.key}'s marker.`);
          expect(framesOf(client, x.id).some(eventOf(x.id, 'turnEnd')), `A client of ${x.id} did not see its turn end.`);
          expect(!client.events.some((/** @type {any} */ e) => e.event === 'tool'), 'A client was sent a tool call.');
        }
      }
      const mix = chats.map((x) => x.key).join(', ');
      return `${CHATS} chats at once (${mix}); each raised its own card and ended; no chat's record held another's marker; the dropped client came back to the full record`;
    } finally {
      for (const x of chats) {
        x.a.close();
        x.b.close();
      }
    }
  },
};
