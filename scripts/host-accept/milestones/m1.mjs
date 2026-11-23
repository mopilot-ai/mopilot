// Milestone M1 (leave and return): S1, a card that nobody answers while the app is gone, and S2, a second client that only watches.
import { ask, chat, expect, hostUp, replyOf, session, until } from '../steps.mjs';
import { eventOf, framesOf, killApp, later, pending, waitCard } from './common.mjs';
import { dropScratch, planS1 } from './harness.mjs';

/** The tool the driving client announces in S2, and what it answers with. */
const TOOL = 'accept_echo';
const TOOL_ANSWER = 'echoed by the driving client';

export const M1_STEPS = [
  {
    id: 'S1a',
    title: 'M1/S1 A card waits, the app side is killed, the Host stays up and keeps the card',
    async run(ctx) {
      const plan = await planS1(ctx, 11);
      if (plan.skip) return (ctx.state.s1skip = plan.skip), { skip: plan.skip };
      const { w, chatId: id, pick, scratch } = plan;
      ctx.state.s1 = { chatId: id, w, pick, scratch };
      try {
        const c = await ask(ctx, id, plan.prompt, plan.start);
        const card = await waitCard(c, id);
        expect(card.cardKind === w.cardKind, `The card is a ${card.cardKind} card, not ${w.cardKind}.`);
        ctx.state.s1.requestId = card.requestId;
        c.close();
        const app = await killApp(ctx);
        const up = await hostUp(ctx);
        expect(up.pid === ctx.state.pid, `The Host was replaced (${ctx.state.pid} to ${up.pid}) when the app side went.`);
        const again = await session(ctx);
        try {
          const still = (await pending(again)).cards.find((x) => x.requestId === card.requestId);
          expect(still, 'The card is gone from host.pending after the app side was killed.');
          return `${w.id}${pick.model ? ` (${pick.model}${pick.effort ? `, ${pick.effort}` : ''})` : ''}: card ${card.requestId} (${card.summary.tool}: ${card.summary.line}); ${app}; Host ${up.pid} stayed up and still lists the card`;
        } finally {
          again.close();
        }
      } catch (e) {
        await dropScratch(ctx);
        throw e;
      }
    },
  },
  {
    id: 'S1b',
    title: 'M1/S1 The card expires, attention says paused with its reason, and a message resumes the run',
    async run(ctx) {
      if (ctx.state.s1skip) return { skip: `S1a was skipped: ${ctx.state.s1skip}` };
      expect(ctx.state.s1?.requestId, 'S1a did not leave a waiting card.');
      const { chatId, requestId, w, pick } = ctx.state.s1;
      const minutes = ctx.opts.waitPauseMin;
      // the clock is the Host's own (approvalTimes: 10 min to remind, 30 to pause) and no setting of a running Host shortens it yet
      if (!minutes) {
        await dropScratch(ctx);
        return {
          skip: 'GAP: the Host exposes no card-timeout setting to shorten (approvalTimes is fixed at 30 minutes until U2’s policy lane); run with --wait-pause 31 to wait it out',
        };
      }
      const c = await session(ctx);
      try {
        await c.request('chat.subscribe', { chatId, epoch: 1, fromRev: 0 });
        await until(async () => (await pending(c)).attention.find((a) => a.chatId === chatId && a.kind === 'paused'), {
          ms: minutes * 60_000,
          every: 5_000,
          what: `${chatId} to be paused`,
        });
        // the parser names the one reason there is; the Host's own line is what says it
        const said = (await c.request('host.pending')).attention.find((/** @type {any} */ a) => a.chatId === chatId)?.reason;
        expect(said === 'approval_timeout', `The pause says "${said}", not approval_timeout.`);
        const expired = await c.waitFor(eventOf(chatId, 'permissionCancelled', { requestId, reason: 'expired' }), 30_000);
        expect(expired, 'The card was not closed as expired.');
        expect(
          (await pending(c)).cards.every((x) => x.requestId !== requestId),
          'The expired card still waits in host.pending.',
        );
        const next = later(c, w.settled(chatId));
        await c.request('chat.send', { chatId, epoch: 1, key: 'accept-resume-s1', text: w.resumeText, ...pick });
        const wrong = w.resumed(await c.waitFor(next, w.waitMs));
        expect(!wrong, wrong);
        expect(
          (await pending(c)).attention.every((a) => a.chatId !== chatId),
          'The chat is still marked as needing attention after the resume.',
        );
        return `paused (${said}) after the clock; card closed as expired; chat.send resumed the run and it ended end_turn`;
      } finally {
        c.close();
        await dropScratch(ctx);
      }
    },
  },
  {
    id: 'S2',
    title: 'M1/S2 A watching client never takes the tool calls of the client that drives the chat',
    async run(ctx) {
      const id = chat(ctx, 12);
      const tools = [{ name: TOOL, description: 'Echoes for the acceptance run', policy: 'observe' }];
      const driver = await session(ctx);
      const watcher = await session(ctx);
      try {
        await driver.request('host.toolsSync', { tools });
        await driver.request('chat.subscribe', { chatId: id, epoch: 1, fromRev: 0 });
        // the watcher can run tools too: it must still only watch
        await watcher.request('host.toolsSync', { tools });
        await watcher.request('chat.subscribe', { chatId: id, epoch: 1, fromRev: 0 });
        await driver.request('chat.start', {
          chatId: id,
          epoch: 1,
          key: `accept-${id}`,
          harness: 'acp:fake',
          text: `MCPTOOL ${TOOL} {}`,
          cwd: ctx.state.dataDir,
        });
        const call = await driver.waitFor((e) => e.event === 'tool' && e.chatId === id, 30_000);
        const next = later(driver, replyOf(id));
        await driver.request('host.toolResult', {
          chatId: id,
          epoch: call.epoch ?? 1,
          callId: call.callId,
          ok: true,
          content: [{ type: 'text', text: TOOL_ANSWER }],
        });
        const reply = (await driver.waitFor(next, 30_000)).frame.item;
        expect(reply.stopReason === 'end_turn', `The turn ended with ${reply.stopReason}.`);
        expect(!watcher.events.some((e) => e.event === 'tool'), 'The watching client was sent a tool call.');
        expect(framesOf(watcher, id).some(replyOf(id)), 'The watching client did not see the reply.');
        return `call ${call.callId} went to the driving client and completed; the watcher saw the reply and no tool call`;
      } finally {
        driver.close();
        watcher.close();
      }
    },
  },
];
