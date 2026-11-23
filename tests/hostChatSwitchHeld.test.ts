// A machine chat's choice of another agent when things do not go straight (D13, #4278, S2): held behind a card, a start that fails, a family the Host does not run, and a Host that restarted. W: held; B: refused or kept with a reason; I: the lane never shows a choice the Host no longer holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, base, openAll, until } from './support/host/switchKit.ts';

const folder = () => fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));

test('W: a choice made while a card waits is held, a Stop does not drop it, and it settles with the next message', async () => {
  const h = await openAll(fs.mkdtempSync(path.join(base, 'card-')));
  try {
    const chatId = AGENTS.claude.id();
    await h.call('chat.subscribe', chatId);
    await h.call('chat.start', chatId, { harness: 'claude', text: 'TOOL please', cwd: folder() });
    await until(() => h.sessions.state.snapshot(chatId).turn === 'awaitingUser');
    await h.call('chat.switch', chatId, { harness: 'codex' });
    assert.equal(h.sessions.controller.ref(chatId).kind, 'claude');
    assert.equal(h.sessions.state.snapshot(chatId).pendingSwitch.harness, 'codex');
    await h.call('chat.stop', chatId);
    await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
    assert.equal(h.sessions.state.snapshot(chatId).pendingSwitch.harness, 'codex');
    await h.call('chat.send', chatId, { text: 'after the card' });
    await until(() => h.sessions.controller.ref(chatId).kind === 'codex');
    await until(() => h.prompts.codex().some((t) => t.includes('after the card')));
  } finally {
    await h.close();
  }
});

test('B: a switch that cannot start the new agent keeps the choice and says why; the chat stays where it was and the next message tries again', async () => {
  const h = await openAll(fs.mkdtempSync(path.join(base, 'fail-')));
  try {
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
    // the message is refused with the reason (a start that did not happen is not a message taken), and the Host keeps nothing of it
    await assert.rejects(
      h.call('chat.send', chatId, { text: 'second' }),
      (e: any) =>
        e.code === 'unsupported' && /Couldn't start Claude Code: no such binary\. Your message is kept in the queue/.test(e.message),
    );
    assert.deepEqual(h.sessions.state.snapshot(chatId).queue, []);
    assert.equal(h.sessions.controller.ref(chatId).kind, 'codex');
    assert.equal(h.sessions.state.snapshot(chatId).pendingSwitch.harness, 'claude', 'the choice is still held');
    assert.deepEqual(h.lane(chatId).at(-1), { pendingSwitch: { harness: 'claude' } });
    runner.startNative = start;
    await h.call('chat.send', chatId, { text: 'third' });
    await until(() => h.sessions.controller.ref(chatId).kind === 'claude');
  } finally {
    await h.close();
  }
});

test('B: a family this Host does not run is refused by name and nothing is held; an agent it has no record of is refused too', async () => {
  const h = await openAll(fs.mkdtempSync(path.join(base, 'lack-')), { claude: true });
  try {
    const chatId = AGENTS.claude.id();
    await h.call('chat.subscribe', chatId);
    await h.call('chat.start', chatId, { harness: 'claude', text: 'first', cwd: folder() });
    await h.idle(chatId, 1);
    await assert.rejects(h.call('chat.switch', chatId, { harness: 'codex' }), /Codex is not available on this Host/);
    await assert.rejects(h.call('chat.switch', chatId, { harness: 'acp:nope' }), /not installed/);
    assert.equal(h.sessions.state.snapshot(chatId).pendingSwitch, null);
  } finally {
    await h.close();
  }
});

test('I: this Host offers switching, and after a restart the lane still reads the choice nobody settled', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'restart-'));
  const chatId = AGENTS.codex.id();
  const first = await openAll(dir);
  try {
    assert.ok(first.agreed.features.includes('switch'));
    await first.call('chat.subscribe', chatId);
    await first.call('chat.start', chatId, { harness: 'codex', text: 'first', cwd: folder() });
    await first.idle(chatId, 1);
    await first.call('chat.switch', chatId, { harness: 'claude' });
    assert.deepEqual(first.lane(chatId).at(-1), { pendingSwitch: { harness: 'claude' } });
  } finally {
    await first.close();
  }
  const second = await openAll(dir);
  try {
    const seen = await second.hello(chatId);
    assert.deepEqual(seen.find((m: any) => m.frame?.t === 'hello')?.frame.chatState.pendingSwitch, { harness: 'claude' });
  } finally {
    await second.close();
  }
});

/** A folder under git with one commit, so the handoff record has repository details to read. */
function repo() {
  const cwd = folder();
  const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a');
  run('add', '.');
  run('commit', '-q', '-m', 'one');
  return cwd;
}

for (const [from, to] of [
  ['claude', 'codex'],
  ['codex', 'claude'],
] as const) {
  test(`W: a ${from} chat moves to ${to} asked to write a handoff note: a note that cannot be written falls back to the workspace record, which names the repository`, async () => {
    const h = await openAll(fs.mkdtempSync(path.join(base, 'note-')));
    try {
      const chatId = AGENTS[from].id();
      await h.call('chat.subscribe', chatId);
      await h.call('chat.start', chatId, { harness: AGENTS[from].harness, text: 'FIRSTWORDS', cwd: repo() });
      await h.idle(chatId, 1);
      await h.call('chat.switch', chatId, { harness: AGENTS[to].harness });
      // the person's own wire holds the automatic mode; the note is the app's other mode, set on the chat's state
      h.sessions.state.patch(chatId, { pendingSwitch: { ...h.sessions.state.snapshot(chatId).pendingSwitch, mode: 'summary' } });
      await h.call('chat.send', chatId, { text: 'SECONDWORDS' });
      await until(() => h.sessions.controller.ref(chatId).kind === AGENTS[to].harness);
      await h.idle(chatId, 2);
      const segment = h.sessions.chats.record(chatId).segments[1];
      // the fake agents write no note: the switch goes on with the workspace alone, as the app's does
      assert.equal(segment.handoff.mode, 'workspace');
      assert.match(h.prompts[to]().at(-1) as string, /Branch: main|branch main/i);
    } finally {
      await h.close();
    }
  });
}

test('W: a Host that runs no Claude Code still moves a chat between its other agents', async () => {
  const h = await openAll(fs.mkdtempSync(path.join(base, 'noclaude-')), { codex: true });
  try {
    const chatId = AGENTS.codex.id();
    await h.call('chat.subscribe', chatId);
    await h.call('chat.start', chatId, { harness: 'codex', text: 'FIRSTWORDS', cwd: folder() });
    await h.idle(chatId, 1);
    await h.call('chat.switch', chatId, { harness: 'acp:fake' });
    await h.call('chat.send', chatId, { text: 'SECONDWORDS' });
    await until(() => h.sessions.controller.ref(chatId).kind === 'acp:fake');
    await until(() => h.prompts.acp().some((t) => /FIRSTWORDS/.test(t) && /SECONDWORDS/.test(t)));
  } finally {
    await h.close();
  }
});
