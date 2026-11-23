// Claude Code turns on the Host (host/src/claudeFamily.mjs): the app's own ClaudeAdapter and Claude harness run through the Host's composition root with a fake Agent SDK playing the CLI. A: turns, queueing, Stop and overlapping starts; W: the chat's session and transcript across a Host restart; B: a CLI that dies, a card that goes away, images the model cannot take; I: the stream names the chat and turn the receipt names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createClaudeFamily, spawnClaudeCode } from '../host/src/claudeFamily.mjs';
import { installElectronPorts } from '../host/src/electronPorts.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { helloParams } from '../shared/host/schema.mjs';
// @ts-ignore: plain ESM without declarations
import { createFakeClaudeSdk } from './support/fakeClaudeSdk.mjs';
import { base, configDir, setup, until, uuid, keyOf, idle } from './support/host/claudeKit.ts';

test('A: a message runs a whole turn on the real adapter and harness: the stream hears it start, the words and its end, under the id the receipt names', async () => {
  const h = setup();
  try {
    const key = keyOf();
    const sent = await h.sessions.chatRuntime.send({ key, text: 'hello there', cwd: h.dir });
    assert.equal(sent.action, 'started');
    await idle(h, key);
    assert.equal(h.text(key), 'fake-claude: hello there');
    const [start] = h.of('turnStart', key);
    const [end] = h.of('turnEnd', key);
    assert.equal(end.turnId, start.turnId);
    assert.equal(end.stopReason, 'end_turn');
    assert.equal(end.error, undefined);
    // the turn starts with what the person wrote
    assert.deepEqual(start.user, { id: `u-${start.turnId}`, clientId: start.turnId, content: [{ type: 'text', text: 'hello there' }] });
    // I: the stream's turn is the one the receipt names, so a client matches the reply to its message
    assert.equal(start.turnId, sent.turnId);
    assert.ok(h.of('update', key).every((e) => e.turnId === start.turnId));
    // the chat's session started in the folder the first message named, as a new session (not a resume)
    const [q] = h.fake.queries;
    assert.equal(q.options.cwd, h.dir);
    assert.equal(q.options.sessionId, key.slice('claude:'.length));
    assert.equal(q.options.resume, undefined);
    assert.equal(q.options.pathToClaudeCodeExecutable, path.join(h.dir, 'claude'));
    assert.ok(h.state(key).rev > 0);
  } finally {
    await h.close();
  }
});

test('A: an assistant message the CLI did not stream arrives whole, and one it streamed is not told twice', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'SILENT', cwd: h.dir });
    await idle(h, key);
    assert.equal(h.text(key), 'whole: SILENT');
    const other = keyOf();
    await h.sessions.chatRuntime.send({ key: other, text: 'streamed', cwd: h.dir });
    await idle(h, other);
    assert.equal(h.text(other), 'fake-claude: streamed');
  } finally {
    await h.close();
  }
});

test('A: a message sent while a turn runs is queued, and Stop ends the running turn as cancelled', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'SLOW first', cwd: h.dir });
    await until(() => h.state(key).turn === 'running' && h.text(key) === 'working');
    const second = await h.sessions.chatRuntime.send({ key, text: 'second' });
    assert.equal(second.action, 'queued');
    assert.equal(h.state(key).queue.length, 1);
    await h.sessions.chatRuntime.host.cancel(key);
    await until(() => h.of('turnEnd', key).length > 0);
    assert.equal(h.of('turnEnd', key)[0].stopReason, 'cancelled');
    assert.equal(h.fake.queries[0].interrupted, true);
    assert.notEqual(h.state(key).turn, 'crashed');
    // one session served the chat: the stop did not start another
    assert.equal(h.fake.queries.length, 1);
  } finally {
    await h.close();
  }
});

test('A: Stop with a permission card up refuses the call, closes the card and ends the turn; the card has no answer after it', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'TOOL please', cwd: h.dir });
    const [card] = await until(() => h.of('permission', key).length && h.of('permission', key));
    assert.equal(card.toolCall.title, 'Run ls');
    assert.deepEqual(card.toolCall.rawInput, { command: 'ls' });
    assert.deepEqual(
      card.options.map((o: any) => o.optionId),
      ['allow', 'deny'],
    );
    await h.sessions.chatRuntime.host.cancel(key);
    await until(() => h.of('turnEnd', key).length > 0);
    assert.equal(h.of('turnEnd', key)[0].stopReason, 'cancelled');
    assert.equal(h.of('permissionCancelled', key)[0].requestId, card.requestId);
    assert.equal(h.sessions.chatRuntime.permit({ requestId: card.requestId, optionId: 'allow' }), false);
    assert.equal(h.state(key).approvals.length, 0);
  } finally {
    await h.close();
  }
});

test('A: the app’s answer to a card lets the call run, or refuses it; a dismissed card is a refusal, and an unknown card is not ours', async () => {
  const h = setup();
  try {
    const allowed = keyOf();
    await h.sessions.chatRuntime.send({ key: allowed, text: 'TOOL one', cwd: h.dir });
    const [first] = await until(() => h.of('permission', allowed).length && h.of('permission', allowed));
    assert.equal(h.sessions.chatRuntime.permit({ requestId: first.requestId, optionId: 'allow' }), true);
    await idle(h, allowed);
    assert.equal(h.text(allowed), 'ran ls');
    const refused = keyOf();
    await h.sessions.chatRuntime.send({ key: refused, text: 'TOOL two', cwd: h.dir });
    const [second] = await until(() => h.of('permission', refused).length && h.of('permission', refused));
    assert.equal(h.sessions.chatRuntime.permit({ requestId: second.requestId }), true);
    await idle(h, refused);
    assert.match(h.text(refused), /refused: The user declined/);
    assert.equal(h.sessions.chatRuntime.permit({ requestId: 'cperm-nope', optionId: 'allow' }), false);
    assert.equal(h.state(allowed).approvals.length, 0);
  } finally {
    await h.close();
  }
});

test('B: a CLI that dies mid-turn ends the turn with an error, keeps the queue, and the next message starts the chat again as a resume', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'CRASH now', cwd: h.dir });
    await until(() => h.of('turnEnd', key).length > 0);
    const [end] = h.of('turnEnd', key);
    assert.equal(end.stopReason, 'error');
    assert.match(end.error.message, /quit while working/);
    assert.equal(h.state(key).turn, 'crashed');
    // a message after the crash runs the chat on a new process that resumes the session the first one wrote
    await h.sessions.chatRuntime.send({ key, text: 'again' });
    await until(() => h.of('turnEnd', key).length > 1);
    assert.equal(h.of('turnEnd', key)[1].stopReason, 'end_turn');
    assert.equal(h.fake.queries.length, 2);
    assert.equal(h.fake.queries[1].options.resume, key.slice('claude:'.length));
    assert.equal(h.fake.queries[1].options.cwd, h.dir);
  } finally {
    await h.close();
  }
});

test('B: a start the SDK cannot make refuses the message with the reason instead of leaving the chat running, and the next message can start it', async () => {
  const h = setup();
  try {
    h.fake.failStart = 'the SDK would not start';
    const key = keyOf();
    // the start is refused with its reason, and the Host keeps nothing of the message (#4786): the person sends it again
    await assert.rejects(h.sessions.chatRuntime.send({ key, text: 'hello', cwd: h.dir }), /the SDK would not start/);
    await until(() => h.of('turnEnd', key).length > 0);
    assert.equal(h.of('turnEnd', key)[0].stopReason, 'error');
    assert.match(h.of('turnEnd', key)[0].error.message, /the SDK would not start/);
    assert.equal(h.state(key).turn, 'crashed');
    assert.equal(h.fake.queries.length, 0);
    assert.deepEqual(h.state(key).queue, []);
    // the failure is not kept: the chat starts once the SDK can
    h.fake.failStart = null;
    await h.sessions.chatRuntime.send({ key, text: 'retry' });
    await until(() => h.of('turnEnd', key).length > 1);
    assert.equal(h.of('turnEnd', key)[1].stopReason, 'end_turn');
    assert.equal(h.text(key), 'fake-claude: retry');
  } finally {
    await h.close();
  }
});

test('W: a Host that restarts mid-turn leaves the chat’s transcript; the next Host resumes it in the folder the transcript names', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'restart-'));
  const key = keyOf();
  const first = setup(dir);
  await first.sessions.chatRuntime.send({ key, text: 'SLOW before the restart', cwd: first.dir });
  await until(() => first.state(key).turn === 'running' && first.text(key) === 'working');
  assert.equal(first.sessions.idle(), false, 'an update does not restart the Host over a running turn');
  await first.close();
  assert.equal(first.fake.queries[0].ended, true, 'the CLI was asked to quit');
  assert.equal(first.fake.queries[0].interrupted, true, 'a running turn is interrupted first');
  assert.ok(fs.existsSync(path.join(configDir, 'projects', 'fake-project', `${key.slice('claude:'.length)}.jsonl`)));

  const second = setup(dir);
  try {
    assert.equal(second.sessions.idle(), true);
    // the new Host knows nothing of the chat: its message resumes the session, in the folder the transcript names
    const sent = await second.sessions.chatRuntime.send({ key, text: 'after the restart' });
    assert.equal(sent.action, 'started');
    await idle(second, key);
    assert.equal(second.text(key), 'fake-claude: after the restart');
    const [q] = second.fake.queries;
    assert.equal(q.options.resume, key.slice('claude:'.length));
    assert.equal(q.options.cwd, dir);
  } finally {
    await second.close();
  }
});

test('A: two first messages of a new chat at once register one session, and a late one does not make a started chat new again', async () => {
  const h = setup();
  try {
    const key = keyOf();
    const [a, b] = await Promise.all([
      h.sessions.chatRuntime.send({ key, text: 'one', cwd: h.dir }),
      h.sessions.chatRuntime.send({ key, text: 'two', cwd: h.dir }),
    ]);
    assert.deepEqual([a.action, b.action].sort(), ['queued', 'started']);
    await until(() => h.of('turnEnd', key).length === 2);
    assert.deepEqual(
      h
        .of('turnStart', key)
        .map((e) => e.user.content[0].text)
        .sort(),
      ['one', 'two'],
      'each turn starts with its own message',
    );
    assert.equal(h.fake.queries.length, 1, 'one session served both');
    assert.equal(h.fake.queries[0].options.resume, undefined);
    // a prepare that arrives after the turn started finds the session registered and leaves it be
    await h.family.prepare(key, h.dir);
    assert.equal(h.sessions.controller.claudeTurns.isFresh(key), false);
  } finally {
    await h.close();
  }
});

test('B: an image the model APIs take goes through, a BMP becomes a PNG, and one nothing can read is said not to be attached', async () => {
  const h = setup();
  try {
    const key = keyOf();
    const png = path.join(h.dir, 'a.png');
    fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    // a 1x1 24-bit BMP
    const bmp = path.join(h.dir, 'b.bmp');
    const px = Buffer.alloc(54 + 4);
    px.write('BM', 0);
    px.writeUInt32LE(58, 2);
    px.writeUInt32LE(54, 10);
    px.writeUInt32LE(40, 14);
    px.writeInt32LE(1, 18);
    px.writeInt32LE(1, 22);
    px.writeUInt16LE(1, 26);
    px.writeUInt16LE(24, 28);
    px.set([10, 20, 30], 54);
    fs.writeFileSync(bmp, px);
    const broken = path.join(h.dir, 'c.heic');
    fs.writeFileSync(broken, 'not an image');
    await h.sessions.controller.send(
      key,
      {
        text: 'look',
        attachments: [
          { kind: 'image', path: png, name: 'a.png' },
          { kind: 'image', path: bmp, name: 'b.bmp' },
          { kind: 'image', path: broken, name: 'c.heic' },
        ],
        opts: {},
      },
      null,
      true,
    );
    await idle(h, key);
    const content = h.fake.queries[0].messages[0].content;
    const images = content.filter((c: any) => c.type === 'image');
    assert.deepEqual(
      images.map((i: any) => i.source.media_type),
      ['image/png', 'image/png'],
    );
    assert.equal(Buffer.from(images[1].source.data, 'base64').toString('latin1', 1, 4), 'PNG');
    assert.match(content.find((c: any) => c.type === 'text').text, /c\.heic couldn't be attached/);
  } finally {
    await h.close();
  }
});

test('the families are told apart: Codex is still not run here, Claude Code is, and the chat runtime says which', async () => {
  const h = setup();
  try {
    await h.sessions.chatRuntime.prepare({ chatId: keyOf(), harness: 'claude', cwd: h.dir });
    await assert.rejects(h.sessions.chatRuntime.prepare({ chatId: 'x', harness: 'codex' }), /cannot run that harness yet/);
    await assert.rejects(
      h.sessions.chatRuntime.send({ key: '019a0000-0000-7000-8000-000000000001', text: 'hi' }),
      /Codex is not available/,
    );
  } finally {
    await h.close();
  }
});

test('the protocol starts a Claude Code chat on these sessions and serves its reply, and refuses a harness the Host does not run', async () => {
  const h = setup();
  try {
    const quiet = { report: () => undefined };
    const epochs = createEpochStore(path.join(h.dir, 'e.json'), quiet);
    const guard = createGuard({ epochs, ledger: createLedger(path.join(h.dir, 'l'), quiet) });
    const protocol = createProtocol({ runtime: h.sessions.chatRuntime, epochs, guard, status: () => ({ running: true }) });
    const frames: any[] = [];
    const conn = protocol.connection((m: any) => frames.push(m));
    await conn.call('host.hello', helloParams());
    const chatId = keyOf();
    const scope = { chatId, epoch: 1 };
    await conn.call('chat.subscribe', scope);
    const started: any = await conn.call('chat.start', {
      ...scope,
      key: 'key-00000001',
      harness: 'claude',
      text: 'ping',
      cwd: h.dir,
      projectId: 'p',
    });
    assert.equal(started.result.action, 'started');
    await until(() => frames.some((m) => m.frame?.item?.t === 'assistant'));
    assert.equal(frames.find((m) => m.frame?.item?.t === 'assistant').frame.item.text, 'fake-claude: ping');
    // the stream names the chat's family: Claude Code's events are not read as ACP's
    const events = frames.filter((m) => m.frame?.item?.t === 'event');
    assert.ok(events.length >= 2, 'turnStart and turnEnd');
    assert.ok(events.every((m) => m.frame.item.family === 'claude'));
    // a Claude Code chat is named claude:<id>
    await assert.rejects(
      conn.call('chat.start', {
        chatId: '019a0000-0000-7000-8000-000000000003',
        epoch: 1,
        key: 'key-00000005',
        harness: 'claude',
        text: 'hi',
        projectId: 'p',
      }),
      /does not belong to the harness/,
    );
    await assert.rejects(
      conn.call('chat.start', {
        chatId: '019a0000-0000-7000-8000-000000000002',
        epoch: 1,
        key: 'key-00000002',
        harness: 'codex',
        text: 'hi',
        projectId: 'p',
      }),
      /cannot run that harness yet/,
    );
    // a Claude Code card answered over the wire closes for everyone who follows the chat
    const toolChat = keyOf();
    await conn.call('chat.subscribe', { chatId: toolChat, epoch: 1 });
    await conn.call('chat.send', { chatId: toolChat, epoch: 1, key: 'key-00000003', text: 'TOOL', cwd: h.dir });
    const card = await until(() => h.of('permission', toolChat)[0]);
    const answered: any = await conn.call('chat.answer', {
      chatId: toolChat,
      epoch: 1,
      key: 'key-00000004',
      requestId: card.requestId,
      optionId: 'allow',
    });
    assert.deepEqual(answered.result, { answered: true });
    await idle(h, toolChat);
  } finally {
    await h.close();
  }
});

test('closing the sessions stops what the family runs, and a family whose stop fails is only noted', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'close-'));
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {} });
  let closed = 0;
  const sessions = createHostSessions({
    paths,
    env: {},
    runtime,
    families: {
      claude: () => ({
        claudeTurns: {},
        claude: {},
        close: () => {
          closed++;
          throw new Error('the CLI would not quit');
        },
      }),
    },
  });
  // a family with no card to answer is not asked twice
  assert.equal(sessions.chatRuntime.permit({ requestId: 'x' }), false);
  sessions.close();
  runtime.close();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, 1);
});

test('A: a message of Sage’s own goes through the controller like the person’s, and a goal is kept in the store; the Host has nobody to notify', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'first', cwd: h.dir });
    await idle(h, key);
    const adapter = h.sessions.controller.claudeTurns;
    // a /goal command the adapter sends itself
    await adapter.enqueue(key, { id: uuid(), text: 'from the adapter', opts: {} });
    await until(() => h.of('turnEnd', key).length > 1);
    assert.match(h.text(key), /fake-claude: from the adapter/);
    // a goal is written to the chat's state; a chat whose file cannot take it keeps the goal in memory only
    const goal = { objective: 'ship it', status: 'active', updatedAt: 1 };
    assert.equal(adapter.writeGoal(key, goal), true);
    assert.equal(h.state(key).goal.objective, 'ship it');
    h.sessions.chats.patchMeta = () => {
      throw new Error('the chat file is read-only');
    };
    assert.equal(adapter.writeGoal('claude:unknown', goal), true);
    assert.equal(h.state('claude:unknown').goal.objective, 'ship it');
    assert.equal(adapter.notifyGoal(key, { status: 'paused', body: 'x' }), undefined);
    assert.equal(adapter.notifyLimit(key, 'limit'), undefined);
  } finally {
    await h.close();
  }
});

test('A: a listener of the stream that throws cannot stop the turn it hears', async () => {
  const h = setup();
  try {
    h.sessions.chatRuntime.host.on('event', () => {
      throw new Error('a bad listener');
    });
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'still runs', cwd: h.dir });
    await until(() => h.state(key).turn === 'idle' && h.fake.queries[0]?.messages.length === 1);
    assert.equal(h.state(key).turn, 'idle');
    assert.equal(h.fake.queries[0].messages.length, 1);
  } finally {
    await h.close();
  }
});

test('the Claude binary is the one the environment names, else the claude on PATH, else the harness’s own search', () => {
  const dir = fs.mkdtempSync(path.join(base, 'bin-'));
  const onPath = path.join(dir, 'claude');
  fs.writeFileSync(onPath, '#!/bin/sh\n', { mode: 0o755 });
  const prefsFor = (env: Record<string, string>) => {
    const paths = createPaths({ dataDir: dir, env: {} });
    const restore = installElectronPorts({
      paths: { dataDir: dir, configDir: path.join(dir, 'config') },
      openExternal: async () => undefined,
    });
    const runtime = createAcpRuntime({ paths, env: {} });
    const sessions = createHostSessions({
      paths,
      env,
      runtime,
      families: { claude: createClaudeFamily({ sdk: createFakeClaudeSdk({ configDir }).sdk }) },
    });
    try {
      assert.equal(sessions.controller.claudeTurns.prefs().permission, 'default');
      return sessions.controller.claudeTurns.prefs().claudeBin;
    } finally {
      sessions.close();
      runtime.close();
      restore();
    }
  };
  assert.equal(prefsFor({ MOPILOT_CLAUDE_BIN: '/by/hand/claude', PATH: dir }), '/by/hand/claude');
  assert.equal(prefsFor({ PATH: dir }), onPath);
  assert.equal(prefsFor({ PATH: path.join(dir, 'nowhere') }), undefined);
});

test('A: the SDK is told to start Claude Code through the Host’s spawn, which keeps the child in a group of its own and hands its diagnostics on', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'hello', cwd: h.dir });
    await idle(h, key);
    assert.equal(typeof h.fake.queries[0].options.spawnClaudeCodeProcess, 'function');
    // what the SDK calls for each session starts a child that is the Host's own
    const started = h.fake.queries[0].options.spawnClaudeCodeProcess({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      cwd: h.dir,
      env: process.env,
      signal: new AbortController().signal,
    });
    try {
      assert.equal(started.group, true);
    } finally {
      started.kill('SIGKILL');
    }
    const seen: string[] = [];
    const child = spawnClaudeCode(
      {
        command: process.execPath,
        args: ['-e', "process.stderr.write('the CLI says hi'); process.stdin.resume()"],
        cwd: h.dir,
        env: process.env,
        signal: new AbortController().signal,
      },
      (data) => seen.push(data),
    );
    try {
      assert.ok(Number(child.pid) > 1);
      assert.equal((child as any).group, true, 'a process group of its own, so ending the group reaches its commands');
      await until(() => seen.join('') === 'the CLI says hi');
    } finally {
      child.kill('SIGKILL');
    }
  } finally {
    await h.close();
  }
});

test('A: a turn with tools tells the stream what a local chat shows: thinking, tool calls and their results, the plan, a sub-agent’s call, the context used and the tokens', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'TOOLS please', cwd: h.dir });
    await idle(h, key);
    const mine = h.events.filter((e) => e.key === key && e.kind !== 'threadName');
    const shape = (e: any) => {
      const u = e.update;
      if (!u) return e.kind;
      if (u.sessionUpdate === 'tool_call')
        return `call ${u.toolCallId} ${u.kind} ${u.title}${u._meta.claudeCode.parentToolUseId ? ` in ${u._meta.claudeCode.parentToolUseId}` : ''}`;
      if (u.sessionUpdate === 'tool_call_update') return `result ${u.toolCallId} ${u.status}`;
      if (u.sessionUpdate === 'plan') return `plan ${u.entries.map((x: any) => `${x.status}:${x.content}`).join(',')}`;
      if (u.sessionUpdate === 'usage_update') return `usage ${u.used}/${u.size}`;
      return `${u.sessionUpdate} ${u.content.text}`;
    };
    assert.deepEqual(mine.map(shape), [
      'turnStart',
      'agent_thought_chunk let me look',
      'call tu-bash execute ls',
      'plan in_progress:look',
      'call tu-edit edit Edit /repo/a.txt',
      'call tu-task think dig',
      'call tu-read read Read /repo/b.txt in tu-task',
      'result tu-read completed',
      'result tu-bash completed',
      'result tu-edit failed',
      'result tu-task completed',
      'agent_message_chunk done with tools',
      'usage 226/1000',
      'turnEnd',
    ]);
    const call = (id: string) => mine.find((e) => e.update?.toolCallId === id && e.update.sessionUpdate === 'tool_call').update;
    assert.deepEqual(call('tu-bash').rawInput, { command: 'ls', description: 'List files' });
    assert.deepEqual(call('tu-edit').locations, [{ path: '/repo/a.txt' }]);
    assert.equal(call('tu-edit').rawInput.old_string, 'a');
    assert.equal(call('tu-task')._meta.claudeCode.toolName, 'Task');
    const results = mine.filter((e) => e.update?.sessionUpdate === 'tool_call_update').map((e) => e.update);
    assert.deepEqual(results.find((u: any) => u.toolCallId === 'tu-bash').content, [
      { type: 'content', content: { type: 'text', text: 'a.txt' } },
    ]);
    assert.equal(results.find((u: any) => u.toolCallId === 'tu-bash').rawOutput.output, 'a.txt');
    assert.equal(results.find((u: any) => u.toolCallId === 'tu-read')._meta.claudeCode.parentToolUseId, 'tu-task');
    const end = mine.at(-1);
    assert.equal(end.stopReason, 'end_turn');
    assert.deepEqual(Object.values(end.usage), [30, 11, 341, 300, 0, 'fake']); // input, output, total, cache read, cache write, model
  } finally {
    await h.close();
  }
});

test('B: a result that reports a failure ends the turn with that error, and a Stop is still a stop', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'FAIL please', cwd: h.dir });
    await until(() => h.of('turnEnd', key).length > 0);
    const [end] = h.of('turnEnd', key);
    assert.equal(end.stopReason, 'error');
    assert.equal(end.error.message, 'Credit balance is too low');
    const stopped = keyOf();
    await h.sessions.chatRuntime.send({ key: stopped, text: 'SLOW', cwd: h.dir });
    await until(() => h.state(stopped).turn === 'running' && h.text(stopped) === 'working');
    await h.sessions.chatRuntime.host.cancel(stopped);
    await until(() => h.of('turnEnd', stopped).length > 0);
    // the CLI's result for an interrupted turn is an error result; the person's Stop decides how the turn ended
    assert.equal(h.of('turnEnd', stopped)[0].stopReason, 'cancelled');
    assert.equal(h.of('turnEnd', stopped)[0].error, undefined);
  } finally {
    await h.close();
  }
});

test('A: the model and effort a message goes with run its turn, a later pick changes them on the live CLI, and a message with none keeps the chat’s', async () => {
  const h = setup();
  try {
    const key = keyOf();
    await h.sessions.chatRuntime.send({ key, text: 'first', cwd: h.dir, pick: { model: 'fake-model', effort: 'high' } });
    await idle(h, key);
    const [q] = h.fake.queries;
    assert.equal(q.options.model, 'fake-model');
    assert.equal(q.options.effort, 'high');
    await h.sessions.chatRuntime.send({ key, text: 'second', pick: { model: 'other-model', effort: 'low' } });
    await until(() => h.of('turnEnd', key).length > 1);
    assert.ok(
      q.controls.some((c: any[]) => c[0] === 'setModel' && c[1] === 'other-model'),
      'the live CLI took the new model',
    );
    assert.equal(h.fake.queries.length, 1, 'no new CLI for a pick');
    // a message that picks nothing runs on what the chat last ran with
    await h.sessions.chatRuntime.send({ key, text: 'third' });
    await until(() => h.of('turnEnd', key).length > 2);
    assert.equal(h.fake.queries.length, 1);
  } finally {
    await h.close();
  }
});

test('A: the permission mode a chat starts with is kept for its later turns, and chat.permit changes it for the next turns and the live CLI', async () => {
  const h = setup();
  try {
    const key = keyOf();
    // what chat.start does: ready the chat, set its mode, send
    await h.sessions.chatRuntime.prepare({ chatId: key, harness: 'claude', cwd: h.dir });
    await h.sessions.chatRuntime.setMode({ chatId: key, value: 'full-access' });
    await h.sessions.chatRuntime.send({ key, text: 'first', cwd: h.dir });
    await idle(h, key);
    assert.equal(h.fake.queries[0].options.permissionMode, 'bypassPermissions');
    assert.equal(h.sessions.chats.records.get(key).meta.config.permission, 'full-access', 'kept in the chat’s file');
    await h.sessions.chatRuntime.setMode({ chatId: key, value: 'default' });
    assert.equal(h.sessions.chats.records.get(key).meta.config.permission, 'default');
    await h.sessions.chatRuntime.send({ key, text: 'second' });
    await until(() => h.of('turnEnd', key).length > 1);
    assert.ok(
      h.fake.queries[0].controls.some((c: any[]) => c[0] === 'setPermissionMode'),
      'the live CLI took the mode',
    );
    // a mode the Host does not know, and a chat that is not Claude Code's, are refused
    await assert.rejects(h.sessions.chatRuntime.setMode({ chatId: key, value: 'god-mode' }), /not one this host knows/);
    await assert.rejects(h.sessions.chatRuntime.setMode({ chatId: 'acp:fake:p', value: 'default' }), /Send a message first/);
    assert.equal(h.sessions.chats.records.get(key).meta.config.permission, 'default', 'a refusal changes nothing');
  } finally {
    await h.close();
  }
});

test('A: the Host tells its status the models the CLI offers once it has asked, and a CLI that cannot answer leaves the list empty', async () => {
  const h = setup();
  try {
    assert.deepEqual(h.sessions.modelsOf('claude'), [], 'a status does not wait for the ask');
    await until(() => h.sessions.modelsOf('claude').length);
    const [m] = h.sessions.modelsOf('claude');
    assert.deepEqual([m.id, m.efforts, m.defaultEffort, m.supportsAutoMode], ['fake-model', ['low', 'high'], 'high', false]);
    assert.equal(h.fake.probes, 1);
  } finally {
    await h.close();
  }
  const failing = setup();
  try {
    failing.fake.probeError = 'not signed in';
    failing.sessions.modelsOf('claude');
    await until(() => failing.fake.probes >= 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(failing.sessions.modelsOf('claude'), []);
    assert.equal(failing.fake.probes, 1, 'not asked again at once');
  } finally {
    await failing.close();
  }
  const none = setup();
  try {
    // this machine has no Claude Code (the harness finds none)
    none.family.claude.findBinary = async () => null;
    none.sessions.modelsOf('claude');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(none.fake.probes, 0, 'no CLI, nothing to ask');
  } finally {
    await none.close();
  }
});
