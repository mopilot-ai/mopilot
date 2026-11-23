// A choice of another agent survives a Host restart (D13, #4278, S2b): kept with the chat's waiting messages on disk, back in the session before any message is taken, spent when it settles, dropped with the chat. W: a kill between choose and settle, and a restart after the switch; B: a damaged file, a target that is gone; I: the credential is on disk and never in the lane; the chat's credential choice follows its agent through a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, base, openAll, until } from './support/host/switchKit.ts';

const folder = () => fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
const queueFiles = (dir: string) =>
  fs.existsSync(path.join(dir, 'queues')) ? fs.readdirSync(path.join(dir, 'queues')).filter((n) => n.endsWith('.json')) : [];
const heldOnDisk = (dir: string) => queueFiles(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, 'queues', n), 'utf8')));
const helloOf = async (h: Awaited<ReturnType<typeof openAll>>, chatId: string) =>
  (await h.hello(chatId)).find((m: any) => m.frame?.t === 'hello')?.frame;

test('W: a Host killed between the choice and the message settles the switch with the chat’s next message; a restart after it settled does not replay it', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'kill-'));
  const cwd = folder();
  const chatId = AGENTS.claude.id();
  const first = await openAll(dir);
  try {
    await first.call('chat.subscribe', chatId);
    await first.call('chat.start', chatId, { harness: 'claude', text: 'FIRSTWORDS about the plan', cwd });
    await first.idle(chatId, 1);
    await first.call('chat.switch', chatId, { harness: 'codex', model: 'gpt-x', credential: { source: 'key' } });
    // on disk now, with the credential, in a file only its owner reads
    const [record] = heldOnDisk(dir);
    assert.equal(record.chatId, chatId);
    assert.deepEqual(record.pendingSwitch.credential, { source: 'key' });
    assert.equal(fs.statSync(path.join(dir, 'queues', queueFiles(dir)[0])).mode & 0o077, 0);
  } finally {
    await first.close();
  }

  const second = await openAll(dir);
  try {
    // back in the session before any message is accepted, and on the lane, which never carries the credential
    assert.equal(second.sessions.state.snapshot(chatId).pendingSwitch.harness, 'codex');
    const hello = await helloOf(second, chatId);
    assert.deepEqual(hello.chatState.pendingSwitch, { harness: 'codex', model: 'gpt-x' });
    assert.doesNotMatch(JSON.stringify(hello.chatState), /credential|"key"/);
    await second.call('chat.subscribe', chatId);
    await second.call('chat.send', chatId, { text: 'SECONDWORDS please continue', cwd });
    await until(() => second.sessions.controller.ref(chatId).kind === 'codex');
    await second.idle(chatId, 1);
    const sent = second.prompts.codex().at(-1) as string;
    assert.match(sent, /FIRSTWORDS about the plan/);
    assert.match(sent, /SECONDWORDS please continue/);
    // spent: nothing held, nothing left on disk
    assert.equal(second.sessions.state.snapshot(chatId).pendingSwitch, null);
    assert.deepEqual(queueFiles(dir), []);
  } finally {
    await second.close();
  }

  const third = await openAll(dir);
  try {
    assert.equal(third.sessions.state.snapshot(chatId).pendingSwitch, null);
    assert.equal(third.sessions.controller.ref(chatId).kind, 'codex');
    assert.equal((await helloOf(third, chatId)).chatState.pendingSwitch, null);
    assert.equal((await helloOf(third, chatId)).chatState.harness, 'codex');
  } finally {
    await third.close();
  }
});

test('W: dropping the choice, or removing the chat, leaves nothing on disk', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'drop-'));
  const h = await openAll(dir);
  try {
    const a = AGENTS.claude.id();
    const b = AGENTS.codex.id();
    for (const [chatId, agent] of [
      [a, 'claude'],
      [b, 'codex'],
    ] as const) {
      await h.call('chat.subscribe', chatId);
      await h.call('chat.start', chatId, { harness: agent, text: 'first', cwd: folder() });
      await h.idle(chatId, 1);
    }
    await h.call('chat.switch', a, { harness: 'codex' });
    await h.call('chat.switch', b, { harness: 'claude' });
    assert.equal(heldOnDisk(dir).length, 2);
    // back to the agent it is on: dropped, and its file goes
    await h.call('chat.switch', a, { harness: 'claude' });
    assert.deepEqual(
      heldOnDisk(dir).map((r) => r.chatId),
      [b],
    );
    // the chat removed from this machine takes its choice with it
    await h.call('chat.remove', b);
    assert.deepEqual(queueFiles(dir), []);
  } finally {
    await h.close();
  }
});

test('B: a file that cannot be read, or holds a choice that is not one, is reported and ignored; the messages beside it still wait', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'bad-'));
  const chatId = AGENTS.codex.id();
  const first = await openAll(dir);
  try {
    await first.call('chat.subscribe', chatId);
    await first.call('chat.start', chatId, { harness: 'codex', text: 'first', cwd: folder() });
    await first.idle(chatId, 1);
    await first.call('chat.switch', chatId, { harness: 'claude' });
  } finally {
    await first.close();
  }
  const [name] = queueFiles(dir);
  const file = path.join(dir, 'queues', name);
  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  const waiting = { id: 'q1', text: 'queued one', attachments: [], opts: {} };
  const bads = [
    { harness: 'nope' },
    { ...good.pendingSwitch, model: 5 },
    { ...good.pendingSwitch, mode: 'rm -rf' },
    { ...good.pendingSwitch, effort: 5 },
    { ...good.pendingSwitch, credential: { source: 'cloud' } },
    { ...good.pendingSwitch, credential: { source: 'own', login: 5 } },
    'claude',
    null,
  ];
  for (const [i, bad] of bads.entries()) {
    // one record has a message waiting beside the bad choice, the others only the choice
    const items = i === 0 ? [waiting] : [];
    fs.writeFileSync(file, JSON.stringify({ ...good, items, pendingSwitch: bad }));
    const second = await openAll(dir);
    try {
      assert.equal(second.sessions.state.snapshot(chatId).pendingSwitch, null, JSON.stringify(bad));
      assert.deepEqual(
        second.sessions.state.snapshot(chatId).queue.map((q: any) => q.text),
        items.map((q) => q.text),
      );
      assert.ok(second.reported.some((m) => m.includes('choice of another agent could not be read') && m.includes(chatId)));
      // rewritten without the bad choice, or gone when nothing else waits
      assert.deepEqual(
        queueFiles(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, 'queues', n), 'utf8')).pendingSwitch),
        items.length ? [undefined] : [],
      );
    } finally {
      await second.close();
    }
  }
  // a file that is not JSON at all is reported and kept where it is; the Host starts
  fs.mkdirSync(path.join(dir, 'queues'), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const third = await openAll(dir);
  try {
    assert.equal(third.sessions.state.snapshot(chatId).pendingSwitch, null);
    assert.ok(third.reported.some((m) => m.includes('could not be read and were kept')));
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
  } finally {
    await third.close();
  }
});

test('B: a restored choice whose agent this Host no longer runs fails at the message with the short reason, keeps the choice held and the message with the person', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'gone-'));
  const cwd = folder();
  const chatId = AGENTS.claude.id();
  const first = await openAll(dir);
  try {
    await first.call('chat.subscribe', chatId);
    await first.call('chat.start', chatId, { harness: 'claude', text: 'first', cwd });
    await first.idle(chatId, 1);
    await first.call('chat.switch', chatId, { harness: 'codex' });
  } finally {
    await first.close();
  }
  const second = await openAll(dir, { claude: true });
  try {
    assert.equal(second.sessions.state.snapshot(chatId).pendingSwitch.harness, 'codex');
    await assert.rejects(
      second.call('chat.send', chatId, { text: 'second', cwd }),
      (e: any) =>
        e.code === 'unsupported' &&
        /Couldn't start Codex: Codex is not available on this Host\. Your message is kept in the queue/.test(e.message),
    );
    assert.equal(second.sessions.controller.ref(chatId).kind, 'claude');
    assert.equal(second.sessions.state.snapshot(chatId).pendingSwitch.harness, 'codex');
    assert.deepEqual(second.sessions.state.snapshot(chatId).queue, [], 'a refused message is not kept by the Host (#4786)');
    assert.equal(heldOnDisk(dir).length, 1, 'the choice is still on disk');
  } finally {
    await second.close();
  }
});

test('W: the chat’s credential choice goes with its agent through a switch and a restart: moved to Claude Code it runs on its own sign-in, moved away it does not', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'cred-'));
  const toClaude = AGENTS.codex.id();
  const away = AGENTS.claude.id();
  const first = await openAll(dir, { claude: true, codex: true }, { credentials: true });
  try {
    for (const [chatId, agent] of [
      [toClaude, 'codex'],
      [away, 'claude'],
    ] as const) {
      await first.call('chat.subscribe', chatId);
      await first.call('chat.start', chatId, { harness: agent, text: 'first', cwd: folder(), credential: { source: 'own' } });
      await first.idle(chatId, 1);
    }
    assert.equal(first.ownRuns?.has(away), true);
    assert.equal(first.ownRuns?.has(toClaude), false);
    await first.call('chat.switch', toClaude, { harness: 'claude' });
    await first.call('chat.switch', away, { harness: 'codex' });
    await first.call('chat.send', toClaude, { text: 'second' });
    await first.call('chat.send', away, { text: 'second' });
    await until(() => first.sessions.controller.ref(toClaude).kind === 'claude' && first.sessions.controller.ref(away).kind === 'codex');
    assert.equal(first.ownRuns?.has(toClaude), true);
    assert.equal(first.ownRuns?.has(away), false);
  } finally {
    await first.close();
  }
  const second = await openAll(dir, { claude: true, codex: true }, { credentials: true });
  try {
    assert.equal(second.ownRuns?.has(toClaude), true);
    assert.equal(second.ownRuns?.has(away), false);
  } finally {
    await second.close();
  }
});

test('B: a credential choice that cannot be moved to the chat\u2019s new agent is reported; the switch is settled all the same', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'movefail-'));
  const chatId = AGENTS.claude.id();
  const h = await openAll(dir, { claude: true, codex: true }, { credentials: true });
  try {
    await h.call('chat.subscribe', chatId);
    await h.call('chat.start', chatId, { harness: 'claude', text: 'first', cwd: folder(), credential: { source: 'own' } });
    await h.idle(chatId, 1);
    (h.ownRuns as any).chatCredentials.moved = () => {
      throw new Error('disk full');
    };
    await h.call('chat.switch', chatId, { harness: 'codex' });
    await h.call('chat.send', chatId, { text: 'second' });
    await until(() => h.sessions.controller.ref(chatId).kind === 'codex');
    assert.ok(h.reported.some((m) => /credential choice could not be moved to its new agent: disk full/.test(m)));
    assert.equal(h.sessions.state.snapshot(chatId).pendingSwitch, null);
  } finally {
    await h.close();
  }
});

test('I: after a switch to Claude Code the chat\u2019s later messages prepare its Claude session, not a session named by the chat\u2019s id', async () => {
  const h = await openAll(fs.mkdtempSync(path.join(base, 'prepare-')));
  try {
    const chatId = AGENTS.codex.id();
    await h.call('chat.subscribe', chatId);
    await h.call('chat.start', chatId, { harness: 'codex', text: 'first', cwd: folder() });
    await h.idle(chatId, 1);
    await h.call('chat.switch', chatId, { harness: 'claude' });
    await h.call('chat.send', chatId, { text: 'second' });
    await h.idle(chatId, 2);
    const native = h.sessions.controller.ref(chatId).key;
    await h.call('chat.send', chatId, { text: 'third' });
    await h.idle(chatId, 3);
    const sessions = h.made.claude.claudeTurns.sessions;
    assert.equal(sessions.has(chatId), false, 'no session is named by the chat id');
    assert.equal(sessions.has(native), true);
    assert.ok(h.prompts.claude().some((t) => t.includes('third')));
  } finally {
    await h.close();
  }
});

test('I: after a switch to an ACP agent the chat\u2019s later messages reach the same ACP session', async () => {
  const h = await openAll(fs.mkdtempSync(path.join(base, 'acpmore-')));
  try {
    const chatId = AGENTS.codex.id();
    await h.call('chat.subscribe', chatId);
    await h.call('chat.start', chatId, { harness: 'codex', text: 'first', cwd: folder() });
    await h.idle(chatId, 1);
    await h.call('chat.switch', chatId, { harness: 'acp:fake' });
    await h.call('chat.send', chatId, { text: 'second', cwd: folder() });
    await h.idle(chatId, 2);
    await h.call('chat.send', chatId, { text: 'third', cwd: folder() });
    await h.idle(chatId, 3);
    assert.deepEqual(
      h.prompts.acp().map((t) => t.includes('second') || t.includes('third')),
      [true, true],
    );
    assert.equal(h.sessions.controller.ref(chatId).kind, 'acp:fake');
  } finally {
    await h.close();
  }
});
