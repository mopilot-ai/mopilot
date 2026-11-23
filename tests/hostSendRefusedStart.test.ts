// A message whose turn the Host could not start is refused, not kept (#4786): the Host answers it with its reason as a refusal that may be sent again under the same key, and holds nothing in its queue; a message waiting behind a running turn is still taken and queued. Before, the Host kept the message in its queue and answered `queued` with the reason, which every client read as delivered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, base, openAll, until } from './support/host/switchKit.ts';

const folder = () => fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));

/** A Codex chat that has run once, with the switch to Claude Code made to fail at the start of the new agent: the J8 case of a start the agent refuses. */
async function refusingChat(name: string) {
  const h = await openAll(fs.mkdtempSync(path.join(base, name)));
  const chatId = AGENTS.codex.id();
  await h.call('chat.subscribe', chatId);
  await h.call('chat.start', chatId, { harness: 'codex', text: 'first', cwd: folder() });
  await h.idle(chatId, 1);
  const runner: any = (h.sessions.controller as any).switcher;
  const start = runner.startNative;
  runner.startNative = async () => {
    throw new Error('no such binary');
  };
  await h.call('chat.switch', chatId, { harness: 'claude' });
  return { h, chatId, mend: () => (runner.startNative = start) };
}

test('A: a message whose start the agent refuses is refused with the reason, holds nothing, and runs nothing', async () => {
  const { h, chatId } = await refusingChat('a-');
  try {
    await assert.rejects(
      h.call('chat.send', chatId, { text: 'second' }),
      (e: any) => e.code === 'unsupported' && /Couldn't start Claude Code: no such binary/.test(e.message),
    );
    assert.deepEqual(h.sessions.state.snapshot(chatId).queue, [], 'the Host keeps nothing it refused');
    // the turn did not run: the controller marks the failed start, and the next message (below) clears it; nothing is running
    assert.notEqual(h.sessions.state.snapshot(chatId).turn, 'running');
    assert.equal(h.sessions.state.snapshot(chatId).pendingSwitch.harness, 'claude', 'the choice of another agent is still held');
  } finally {
    await h.close();
  }
});

test('W: the same message sent again under its key runs once the cause is gone, and is delivered once', async () => {
  const { h, chatId, mend } = await refusingChat('w-');
  try {
    const key = 'key-retry-refused-0001';
    await assert.rejects(h.call('chat.send', chatId, { text: 'second', key }), (e: any) => e.code === 'unsupported');
    mend();
    const again: any = await h.call('chat.send', chatId, { text: 'second', key });
    assert.equal(again.replayed, false, 'the refused key ran again');
    assert.equal(again.result.error, undefined);
    await until(() => h.sessions.controller.ref(chatId).kind === 'claude');
    await h.idle(chatId, 2);
    assert.equal(h.prompts.claude().filter((t: string) => t.includes('second')).length, 1);
    assert.deepEqual(h.sessions.state.snapshot(chatId).queue, []);
  } finally {
    await h.close();
  }
});

test('B: a message that waits behind a running turn is taken and queued, with no error', async () => {
  const h = await openAll(fs.mkdtempSync(path.join(base, 'b-')));
  try {
    const chatId = AGENTS.codex.id();
    await h.call('chat.subscribe', chatId);
    await h.call('chat.start', chatId, { harness: 'codex', text: 'slow please', cwd: folder() });
    await until(() => h.sessions.state.snapshot(chatId).turn === 'running');
    const waiting: any = await h.call('chat.send', chatId, { text: 'later' });
    assert.equal(waiting.result.action, 'queued');
    assert.equal(waiting.result.error, undefined);
    assert.deepEqual(
      h.sessions.state.snapshot(chatId).queue.map((q: any) => q.text),
      ['later'],
    );
    await h.call('chat.stop', chatId);
  } finally {
    await h.close();
  }
});

test('W: a Codex turn the app-server refuses to start (its own error) is refused the same way, and the same key goes through once the cause is gone', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'cx-'));
  const h = await openAll(dir);
  try {
    const chatId = AGENTS.codex.id();
    await h.call('chat.subscribe', chatId);
    await h.call('chat.start', chatId, { harness: 'codex', text: 'first', cwd: folder() });
    await h.idle(chatId, 1);
    const flag = `${path.join(dir, 'codex.jsonl')}.refuse`;
    fs.writeFileSync(flag, '');
    const key = 'key-codex-refused-0001';
    await assert.rejects(
      h.call('chat.send', chatId, { text: 'second', key }),
      (e: any) => e.code === 'unsupported' && /not available to this account/.test(e.message),
    );
    assert.deepEqual(h.sessions.state.snapshot(chatId).queue, [], 'the Host keeps nothing it refused');
    fs.rmSync(flag);
    const again: any = await h.call('chat.send', chatId, { text: 'second', key });
    assert.equal(again.replayed, false);
    await h.idle(chatId, 2);
    // the app-server was asked twice (it refused the first), and the chat holds the message once
    assert.equal(h.prompts.codex().filter((t: string) => t.includes('second')).length, 2);
    const said = h.frames.filter((m: any) => m.chatId === chatId && m.frame?.item?.t === 'user' && m.frame.item.text === 'second');
    assert.equal(said.length, 1);
  } finally {
    await h.close();
  }
});
