// Milestone M4 (limits, Host only): S10, a day spend limit set through the owner policy that holds the next message once a turn has crossed it, and lets it go when the limit is raised.
import { chat, expect, replyOf, session, until } from '../steps.mjs';
import { later, refusalOf, rpc } from './common.mjs';

/** The owner policy with a day limit (`null` for none): the Host replaces the whole owner layer. @param {number | null} dayUsd */
const policy = (dayUsd) => ({ version: 1, ...(dayUsd === null ? {} : { spend: { dayUsd } }) });

export const M4_STEPS = [
  {
    id: 'S10',
    title: 'M4/S10 A spend limit holds the next message with spend_limit, and raising it lets the message go',
    async run(ctx) {
      const id = chat(ctx, 26);
      // a model in the shipped price table: 10 000 tokens in and out is about $0.06 at its list price, over the $0.05 day limit
      const text = 'SPEND claude-haiku-4-5 10000 10000';
      const c = await session(ctx);
      try {
        await rpc(ctx, 'host.policy', { doc: policy(0.05) });
        await c.request('chat.subscribe', { chatId: id, epoch: 1, fromRev: 0 });
        await c.request('chat.start', { chatId: id, epoch: 1, key: `accept-${id}`, harness: 'acp:fake', text, cwd: ctx.state.dataDir });
        const crossing = (await c.waitFor(replyOf(id), 30_000)).frame.item;
        expect(crossing.stopReason === 'end_turn', `The crossing turn ended with ${crossing.stopReason}, not end_turn.`);
        const spend = await until(
          async () => {
            const s = (await rpc(ctx, 'status')).spend;
            return s?.dayUsd >= 0.05 && s;
          },
          { what: 'the day total to cross the limit', every: 300 },
        );
        const send = { chatId: id, epoch: 1, key: 'accept-spend-held', text: 'one more please' };
        const held = await refusalOf(ctx, 'chat.send', send);
        expect(held === 'spend_limit', `chat.send over the limit got "${held}", not spend_limit.`);
        await rpc(ctx, 'host.policy', { doc: policy(100) });
        const next = later(c, replyOf(id));
        // the same key: a refusal is not remembered as the key's answer, so the message is still sendable
        await rpc(ctx, 'chat.send', send);
        const sent = (await c.waitFor(next, 30_000)).frame.item;
        expect(sent.text.includes('one more please'), `The released turn said "${sent.text}".`);
        return `the crossing turn ended end_turn at $${spend.dayUsd} of $${spend.dayLimitUsd}; chat.send was refused with spend_limit and, with the same key, went once the limit was $100`;
      } finally {
        c.close();
        await rpc(ctx, 'host.policy', { doc: policy(null) });
      }
    },
  },
];
