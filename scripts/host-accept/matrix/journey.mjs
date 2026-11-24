// The matrix journey on one harness, over the Host's wire: stream a reply, a tool call, an approval answered, stop, resume after the client leaves, the same chat from a second client. What a person on the Mac app or iPhone does beyond the wire (a question card, a harness switch) is listed as not covered, never skipped silently.
import { expect, hostUp, session } from '../steps.mjs';
import { eventOf, framesOf } from '../milestones/common.mjs';
import { awaitReply, drive, fileIs, mark, newChat, startChat, target, turnEnd, watch } from './common.mjs';
import { workFolder } from '../workFolder.mjs';

const TOOL = 'accept_echo';

/** @param {string} key */
export function journeySteps(key) {
  /** @param {string} id @param {string} title @param {(ctx: any, t: any) => Promise<string | { skip: string }>} run */
  const step = (id, title, run) => ({
    id: `${key}/${id}`,
    title: `Matrix ${key} ${id}: ${title}`,
    /** @param {any} ctx */
    async run(ctx) {
      const t = await target(ctx, key);
      return t.skip ? { skip: t.skip } : run(ctx, t);
    },
  });
  /** @param {string} id @param {string} title @param {string} why */
  const notCovered = (id, title, why) => ({
    id: `${key}/${id}`,
    title: `Matrix ${key} ${id}: ${title}`,
    run: async () => ({ skip: `NOT COVERED: ${why}` }),
  });

  return [
    step('J1', 'a chat streams its reply', async (ctx, t) => {
      const marker = mark(ctx);
      const { c, id, t0 } = await startChat(ctx, t, t.w.say(marker));
      try {
        await c.waitFor((e) => e.chatId === id, t.w.waitMs);
        const first = Date.now() - t0;
        const end = await turnEnd(c, id, t.w.waitMs);
        expect(end.frame.item.event.stopReason === 'end_turn', `The turn ended with ${end.frame.item.event.stopReason}.`);
        await awaitReply(c, id, marker);
        return `the reply carried the marker; first frame after ${first} ms; ended end_turn`;
      } finally {
        c.close();
      }
    }),
    step('J2', 'a tool call runs and its result shows', async (ctx, t) => {
      if (!t.w.real) {
        const tools = [{ name: TOOL, description: 'Echoes for the acceptance run', policy: 'observe' }];
        const { c, id } = await startChat(ctx, t, `MCPTOOL ${TOOL} {}`, (client) => client.request('host.toolsSync', { tools }));
        try {
          const call = await c.waitFor((e) => e.event === 'tool' && e.chatId === id, 30_000);
          await c.request('host.toolResult', {
            chatId: id,
            epoch: call.epoch,
            callId: call.callId,
            ok: true,
            content: [{ type: 'text', text: 'echoed' }],
          });
          const end = await turnEnd(c, id, 30_000);
          expect(end.frame.item.event.stopReason === 'end_turn', `The turn ended with ${end.frame.item.event.stopReason}.`);
          return `call ${call.callId} went to the client, its result came back and the turn ended end_turn`;
        } finally {
          c.close();
        }
      }
      // a real harness's tool call is the write it asks to make: after Allow the file is there
      const marker = mark(ctx);
      const { c, id } = await startChat(ctx, t, t.w.approveWith(t.scratch, marker));
      try {
        const cards = await drive(c, id, 'allow', t.w.waitMs, 'j2');
        await fileIs(ctx, t.w.effect(t.scratch, marker), true);
        return `${cards} card(s) allowed; the write ran and its file exists`;
      } finally {
        c.close();
      }
    }),
    step('J3', 'an approval is answered (Deny; Allow too on the fake agent)', async (ctx, t) => {
      const kinds = t.w.real ? ['deny'] : ['allow', 'deny'];
      const said = [];
      for (const kind of /** @type {('allow' | 'deny')[]} */ (kinds)) {
        const marker = mark(ctx);
        const { c, id } = await startChat(ctx, t, t.w.approveWith(t.scratch, marker));
        try {
          const cards = await drive(c, id, kind, t.w.waitMs, `j3${kind}`);
          if (t.w.real && kind === 'deny') await fileIs(ctx, t.w.effect(t.scratch, marker), false);
          said.push(`${kind}: ${cards} card(s), turn ended${t.w.real ? ', no file written' : ''}`);
        } finally {
          c.close();
        }
      }
      return said.join('; ');
    }),
    notCovered(
      'J4',
      'a question is answered',
      'a question card is chosen by the model on a real harness and the fake agent raises none; check it from the client',
    ),
    step('J5', 'Stop ends a running turn', async (ctx, t) => {
      const { c, id } = await startChat(ctx, t, t.w.slow);
      try {
        // a Stop is for a turn that is running: the Stop button of the Mac app and the phone appears then, and a Stop before the controller has begun the turn is counted but never blocks it (controllerSends.cjs noteStop), so the turn would run on
        await c.waitFor(eventOf(id, 'turnStart'), t.w.waitMs);
        // with --stop-delay the Stop comes after the turn's starting window, to tell a lost Stop there from a Stop the harness does not act on
        await new Promise((r) => setTimeout(r, ctx.opts.stopDelayMs));
        // the wire wants a key on a stop, as the Mac app sends one (electron/host/remoteChatCalls.cjs)
        const stoppedAt = Date.now();
        await c.request('chat.stop', { chatId: id, epoch: 1, key: `accept-stop-${id}` });
        const end = await turnEnd(c, id, 60_000);
        expect(
          end.frame.item.event.stopReason === 'cancelled',
          `The stopped turn ended with ${end.frame.item.event.stopReason}, ${Date.now() - stoppedAt} ms after the Stop.`,
        );
        return 'chat.stop ended the running turn as cancelled';
      } finally {
        c.close();
      }
    }),
    step('J6', 'the client leaves and comes back: the turn ran on', async (ctx, t) => {
      const marker = mark(ctx);
      const { c, id } = await startChat(ctx, t, t.w.say(marker));
      c.close();
      const back = await watch(ctx, id);
      try {
        const t0 = Date.now();
        const end = await turnEnd(back, id, t.w.waitMs);
        expect(end.frame.item.event.stopReason === 'end_turn', `The turn ended with ${end.frame.item.event.stopReason}.`);
        await awaitReply(back, id, marker);
        return `the turn finished while no client was there; the returning client was caught up ${Date.now() - t0} ms after it subscribed`;
      } finally {
        back.close();
      }
    }),
    step('J7', 'the same chat from a second client, and back', async (ctx, t) => {
      const first = mark(ctx);
      const second = mark(ctx);
      const a = await startChat(ctx, t, t.w.say(first));
      let b;
      try {
        await turnEnd(a.c, a.id, t.w.waitMs);
        // the second client arrives after the first turn: the history is what it is caught up with
        b = await watch(ctx, a.id);
        await b.waitFor(eventOf(a.id, 'turnEnd'), 10_000);
        await awaitReply(b, a.id, first);
        const countA = a.c.events.length;
        const countB = b.events.length;
        await b.request('chat.send', { chatId: a.id, epoch: 1, key: `accept-j7-${second}`, text: t.w.say(second), ...t.pick });
        const seen = (/** @type {any} */ c, /** @type {number} */ from) =>
          c.waitFor((/** @type {any} */ e) => c.events.indexOf(e) >= from && eventOf(a.id, 'turnEnd')(e), t.w.waitMs);
        await seen(a.c, countA);
        await seen(b, countB);
        for (const client of [a.c, b]) await awaitReply(client, a.id, second);
        return 'the second client saw the history, sent a message, and both clients saw the new turn';
      } finally {
        a.c.close();
        b?.close();
      }
    }),
    notCovered(
      'J8',
      'the harness is switched on the same chat',
      "a switch is a client action (the Mac app's harness switch carries the chat over); the wire run cannot show what carries over",
    ),

    step('J9', 'switch host: this Mac → the Host → back', async (ctx, t) => {
      // the Mac's side is a client action (chat.prepareContinue on the Host, a first chat.send, then the Mac takes the chat back with chat.commitContinue and chat.release); the Host's half is what this run drives, over the same wire
      // a Mac chat's id is its own spelling (a bare id on the Host is a Codex thread): the Host resumes the continue's own session whatever the id spells
      const id = newChat(ctx, t);
      const word = mark(ctx);
      const second = mark(ctx);
      const c = await session(ctx);
      try {
        const cwd = t.start.cwd ?? workFolder(ctx.state);
        const harness = t.w.id;
        const prep = await c.request('chat.prepareContinue', {
          chatId: id,
          epoch: 1,
          key: `accept-j9-prep-${id}`,
          harness,
          cwd,
          handoff: `Earlier in this conversation (held on the user's Mac) the user said: the secret word is ${word}.`,
        });
        expect(!!prep.preparedId, `chat.prepareContinue answered ${JSON.stringify(prep)}.`);
        await c.request('chat.subscribe', { chatId: id, epoch: 1, fromRev: 0 });
        const ask = t.w.real
          ? `What secret word did the user give earlier in this conversation? Reply with exactly that word and nothing else.`
          : `hello ${second}`;
        await c.request('chat.send', { chatId: id, epoch: 1, key: `accept-j9-send-${id}`, text: ask, cwd, ...t.pick });
        const end = await turnEnd(c, id, t.w.waitMs);
        expect(end.frame.item.event.stopReason === 'end_turn', `The first turn here ended with ${end.frame.item.event.stopReason}.`);
        // a real agent names the word only if the conversation was carried; the fake agent echoes the text it was sent, handoff in front
        await awaitReply(c, id, t.w.real ? word : second);
        // back to the Mac: the Mac's own prepare is not on this Host, so this Host is asked to hand the chat over and let go of it
        const commit = await c.request('chat.commitContinue', {
          chatId: id,
          expectedEpoch: 1,
          targetHostId: 'accept-mac',
          preparedId: 'accept-mac-prep',
        });
        expect(commit.epoch === 2, `chat.commitContinue answered ${JSON.stringify(commit)}.`);
        const rel = await c.request('chat.release', { chatId: id, epoch: 2, preparedId: 'accept-mac-prep' });
        expect(rel.released === 'finalized', `chat.release answered ${JSON.stringify(rel)}.`);
        const refused = await c
          .request('chat.send', { chatId: id, epoch: 1, key: `accept-j9-late-${id}`, text: 'late', cwd, ...t.pick })
          .then(
            () => null,
            (/** @type {any} */ e) => e,
          );
        expect(
          refused?.code === 'chat_released',
          `A send after the hand-back was ${refused ? `refused with ${refused.code}` : 'accepted'}.`,
        );
        return `prepared and ran the first message on the ${harness} agent with ${t.w.real ? 'the word from the handoff in the reply' : 'the handoff in front'}, handed the chat back (epoch 2, finalized) and a later send was refused chat_released; the Mac's own message after the hand-back is the app's half and was not run`;
      } finally {
        c.close();
      }
    }),
    step('J10', 'a continue away during a running turn is refused, and the turn runs on', async (ctx, t) => {
      const { c, id } = await startChat(ctx, t, t.w.slow);
      try {
        await c.waitFor(eventOf(id, 'turnStart'), t.w.waitMs);
        const refused = await c
          .request('chat.commitContinue', { chatId: id, expectedEpoch: 1, targetHostId: 'accept-mac', preparedId: 'accept-mac-prep' })
          .then(
            () => null,
            (/** @type {any} */ e) => e,
          );
        expect(
          refused?.code === 'turn_running',
          `A continue during the turn was ${refused ? `refused with ${refused.code}` : 'accepted'}.`,
        );
        await new Promise((r) => setTimeout(r, 100));
        expect(!framesOf(c, id).some(eventOf(id, 'turnEnd')), 'The refusal ended the running turn.');
        await c.request('chat.stop', { chatId: id, epoch: 1, key: `accept-j10-stop-${id}` });
        const end = await turnEnd(c, id, 60_000);
        expect(end.frame.item.event.stopReason === 'cancelled', `The turn ended with ${end.frame.item.event.stopReason}.`);
        return `refused turn_running; the turn kept running until the Stop ended it as cancelled`;
      } finally {
        c.close();
      }
    }),
    step('J11', 'a continue to an agent this machine lacks or is signed out of is refused in words', async (ctx, t) => {
      if (key !== 'fake') return { skip: 'the refusal is about the machine, not the harness: shown once, on the fake key' };
      // the machine's own status says which agents are missing or signed out; the run never installs or signs in, so a machine with neither has nothing to show (the cell then says so)
      const rows = /** @type {any[]} */ ((await hostUp(ctx)).status.harnesses);
      const kindOf = (/** @type {any} */ r) => (r.id === 'claude' || r.id === 'codex' ? r.id : `acp:${r.id}`);
      const missing = rows.find((r) => !r.detected);
      const out = rows.find((r) => r.detected && !r.signedIn && !r.keyed);
      if (!missing && !out)
        return { skip: `every agent on this Host is installed and signed in (${rows.map((r) => r.id).join(', ')}); nothing to refuse` };
      const c = await session(ctx);
      const said = [];
      try {
        for (const [row, code, words] of /** @type {[any, string, RegExp][]} */ ([
          [missing, 'agent_missing', /isn't installed on/],
          [out, 'agent_signed_out', /Sign in|sign in|signed out/],
        ])) {
          if (!row) continue;
          const e = await c
            .request('chat.prepareContinue', {
              chatId: newChat(ctx, t),
              epoch: 1,
              key: `accept-j11-${row.id}`,
              harness: kindOf(row),
              cwd: workFolder(ctx.state),
              handoff: 'x',
            })
            .then(
              () => null,
              (/** @type {any} */ x) => x,
            );
          expect(e?.code === code, `A continue to ${row.id} was ${e ? `refused with ${e.code}` : 'accepted'} (wanted ${code}).`);
          expect(words.test(e.message), `The refusal for ${row.id} said "${e.message}".`);
          said.push(`${row.id}: ${code} "${e.message}"`);
        }
        return said.join('; ');
      } finally {
        c.close();
      }
    }),
  ];
}
