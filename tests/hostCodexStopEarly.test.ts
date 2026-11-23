// A Stop the instant a Codex turn begins, through the Host's own stack (sessions, protocol, the Codex family over the stand-in app-server): the turn is journaled with its id, the app-server refuses an interrupt until the turn's run begins, as the real one did in the live trace; the turn must still end as cancelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { base, open, until } from './support/hostCodexKit.ts';

test('W: a Stop sent as soon as the turn is journaled ends the turn cancelled, though the app-server refused the first interrupts (no active turn yet)', async () => {
  const h = await open(fs.mkdtempSync(path.join(base, 'early-')));
  try {
    const chatId = 'chat-early';
    await h.call('chat.subscribe', chatId);
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
    await h.call('chat.start', chatId, { harness: 'codex', text: 'slowlate please', cwd });
    await until(() => h.events(chatId).some((e) => e.kind === 'turnStart'));
    const stopped: any = await h.call('chat.stop', chatId);
    // the first interrupt was refused: the Stop is pending, and the reply says so rather than that it is done
    assert.deepEqual(stopped.result, { stopped: false, pending: true });
    await until(() => h.events(chatId).some((e) => e.kind === 'turnEnd'), 15_000);
    const interrupts = h.requests().filter((r) => r.method === 'turn/interrupt');
    assert.equal(h.events(chatId).find((e) => e.kind === 'turnEnd').stopReason, 'cancelled', `interrupts sent: ${interrupts.length}`);
    assert.ok(interrupts.length >= 3, 'the interrupts the app-server refused were sent again');
    // the Host's own log tells the stop's steps by chat, with no words of the chat in them
    await until(() => h.logs.some((l) => /no longer the running turn/.test(l)));
    const steps = h.logs.filter((l) => l.includes('[codex-stop]'));
    assert.match(steps[0], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+Z \\[codex-stop\\] chat=${chatId} thread=th-\\S+ turn=\\S+$`));
    assert.ok(
      steps.some((l) => / interrupt sent$/.test(l)) && steps.some((l) => / interrupt refused: no active turn to interrupt$/.test(l)),
    );
    assert.ok(
      steps.some((l) => / repeat 1 sent$/.test(l)) &&
        steps.some((l) => / repeat \d+ refused: no active turn to interrupt$/.test(l)) &&
        steps.some((l) => / repeat \d+ answered$/.test(l)),
    );
    assert.ok(steps.every((l) => l.includes(`chat=${chatId} `) && !/slowlate|please/.test(l)));
  } finally {
    h.close();
  }
});
