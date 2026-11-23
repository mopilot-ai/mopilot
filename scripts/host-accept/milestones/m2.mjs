// Milestone M2 (approve from the phone): S3 and S4 with a fake phone, a second paired client of the Host that answers cards the way the phone does (`chat.answer`, as shared/remote/phoneHost.mjs sends it). S3a runs P6's relay scenario (scripts/host-phone-check.mjs) for the path Host, local relay, fake phone.
import { ask, chat, expect, replyOf, session } from '../steps.mjs';
import { answerCard, framesOf, later, optionOf, pending, waitCard } from './common.mjs';

/** What the fake phone is: a client that sees the card in `host.pending` and answers it. @param {any} ctx */
const fakePhone = (ctx) => session(ctx);

export const M2_STEPS = [
  {
    id: 'S3a',
    title: 'M2/S3 A push reaches the fake phone',
    async run(ctx) {
      // P6's scenario starts its own Host process, local relay and fake phone in a temp directory, so it runs where this script runs
      const code = ctx.deps.phoneCheck();
      expect(code === 0, `P6's phone check (scripts/host-phone-check.mjs) exited ${code}.`);
      return 'P6 phone check passed: Host process, local relay, fake phone enrolled; app killed; the phone saw the card through the relay, answered, and the agent continued. A real push service (APNs) is not part of it';
    },
  },
  {
    id: 'S3b',
    title: 'M2/S3 Allow from the phone lets the agent continue',
    async run(ctx) {
      const id = chat(ctx, 14);
      const mac = await ask(ctx, id, 'PERMIT approve from the phone');
      const phone = await fakePhone(ctx);
      try {
        const card = await waitCard(phone, id);
        expect(card.options.length >= 2, 'The card the phone sees lists no options to pick from.');
        const next = later(mac, replyOf(id));
        await answerCard(phone, card, optionOf(card, 'allow').optionId, 's3-allow');
        const reply = (await mac.waitFor(next, 30_000)).frame.item;
        expect(reply.stopReason === 'end_turn', `The turn ended with ${reply.stopReason}.`);
        expect(
          (await pending(phone)).cards.every((x) => x.requestId !== card.requestId),
          'The card still waits after the phone answered.',
        );
        return `the phone saw "${card.summary.line}" and chose Allow; the agent finished end_turn and the card no longer waits`;
      } finally {
        mac.close();
        phone.close();
      }
    },
  },
  {
    id: 'S3c',
    title: 'M2/S3 Deny from the phone stops the action',
    async run(ctx) {
      const id = chat(ctx, 15);
      const mac = await ask(ctx, id, 'PERMIT deny from the phone');
      const phone = await fakePhone(ctx);
      try {
        const card = await waitCard(phone, id);
        const next = later(mac, replyOf(id));
        await answerCard(phone, card, optionOf(card, 'deny').optionId, 's3-deny');
        const reply = (await mac.waitFor(next, 30_000)).frame.item;
        expect(reply.stopReason === 'end_turn', `The turn ended with ${reply.stopReason}.`);
        expect(
          (await pending(phone)).cards.every((x) => x.requestId !== card.requestId),
          'The card still waits after the phone denied it.',
        );
        const failed = JSON.stringify(framesOf(mac, id)).includes('failed');
        return `the phone chose Deny; the turn ended end_turn and the card closed; the record ${failed ? 'shows the tool call as failed' : 'does not name a failed call'}`;
      } finally {
        mac.close();
        phone.close();
      }
    },
  },
  {
    id: 'S4',
    title: 'M2/S4 Answering on two clients at the same moment: one wins, the other gets card_answered',
    async run(ctx) {
      const id = chat(ctx, 16);
      const mac = await ask(ctx, id, 'PERMIT two answers');
      const phone = await fakePhone(ctx);
      try {
        const card = await waitCard(mac, id);
        const allow = optionOf(card, 'allow').optionId;
        const next = later(mac, replyOf(id));
        const results = await Promise.allSettled([answerCard(mac, card, allow, 's4-mac'), answerCard(phone, card, allow, 's4-phone')]);
        const won = results.filter((r) => r.status === 'fulfilled');
        const lost = results.filter((r) => r.status === 'rejected');
        expect(won.length === 1 && lost.length === 1, `${won.length} answers won and ${lost.length} lost; exactly one must win.`);
        const code = /** @type {any} */ (lost[0]).reason?.code;
        expect(code === 'card_answered', `The losing client got "${code}", not card_answered.`);
        const reply = (await mac.waitFor(next, 30_000)).frame.item;
        expect(reply.stopReason === 'end_turn', `The turn ended with ${reply.stopReason}.`);
        return `one answer won, the other got card_answered (${results[0].status === 'fulfilled' ? 'Mac' : 'phone'} was first); the turn ended once`;
      } finally {
        mac.close();
        phone.close();
      }
    },
  },
];
