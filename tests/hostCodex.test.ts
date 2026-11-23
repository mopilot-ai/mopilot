// Codex on a Host (host/src/codexFamily.mjs): the app's CodexAdapter over a `codex app-server` the Host starts, here a stand-in CLI on the PATH. A: a chat starts, runs and ends on the stream; W: queueing, Stop mid-command, approvals; B: missing or signed-out Codex refuses before anything is kept; I: the app-server crashing, the Host restarting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime, which } from '../host/src/acp.mjs';
import { NOT_INSTALLED, NOT_SIGNED_IN } from '../host/src/codexFamily.mjs';
import { listHarnesses } from '../host/src/harnessState.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
import { base, installCodex, open, refusal, until } from './support/hostCodexKit.ts';

test('A: a new Codex chat starts a thread in its folder, runs the turn, and the reply reaches the stream', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'a-'));
  const h = await open(dir);
  try {
    const chatId = 'chat-a';
    await h.call('chat.subscribe', chatId);
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
    const started: any = await h.call('chat.start', chatId, { harness: 'codex', text: 'hello', cwd });
    assert.equal(started.result.action, 'started');
    await until(() => h.replies(chatId).length > 0 || h.frames.some((m) => m.frame?.item?.t === 'assistant'));
    const reply = h.frames.find((m) => m.frame?.item?.t === 'assistant').frame.item;
    assert.equal(reply.text, 'codex: hello');
    assert.equal(reply.stopReason, 'end_turn');
    await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
    // the thread was started in the chat's folder, and the chat id the client chose names it
    const threadStart = h.requests().find((r) => r.method === 'thread/start');
    assert.equal(threadStart.params.cwd, cwd);
    assert.match(h.sessions.controller.ref(chatId).id, /^th-/);
    assert.equal(h.sessions.controller.chatOf(h.sessions.controller.ref(chatId).id), chatId);
    assert.ok(h.sessions.idle());
  } finally {
    h.close();
  }
});

/** Start a chat and wait until its first turn is done. */
async function started(h: Awaited<ReturnType<typeof open>>, chatId: string, text = 'first') {
  await h.call('chat.subscribe', chatId);
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
  const sent: any = await h.call('chat.start', chatId, { harness: 'codex', text, cwd });
  await until(() => h.sessions.state.snapshot(chatId).turn !== 'idle' || h.frames.some((m) => m.frame?.item?.t === 'assistant'));
  await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
  return { sent, cwd };
}
const endedTurns = (h: Awaited<ReturnType<typeof open>>, chatId: string) => h.events(chatId).filter((e) => e.kind === 'turnEnd');

test('W: a message sent while a turn runs is queued, and Stop ends the running command and keeps the queue', async () => {
  const h = await open(fs.mkdtempSync(path.join(base, 'w-')));
  try {
    const chatId = 'chat-w';
    await started(h, chatId);
    await h.call('chat.send', chatId, { text: 'slow please' });
    await until(() => h.sessions.state.snapshot(chatId).turn === 'running');
    // the command is running when the second message arrives: it waits its turn
    const second: any = await h.call('chat.send', chatId, { text: 'after' });
    assert.equal(second.result.action, 'queued');
    const stopped: any = await h.call('chat.stop', chatId);
    assert.deepEqual(stopped.result, { stopped: true });
    await until(() => h.requests().some((r) => r.method === 'turn/interrupt'));
    await until(() => endedTurns(h, chatId).some((e) => e.stopReason === 'cancelled'));
    await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
    // Stop keeps what was queued (as the app does): nothing runs until the person sends again
    assert.deepEqual(
      h.sessions.state.snapshot(chatId).queue.map((q: any) => q.text),
      ['after'],
    );
  } finally {
    h.close();
  }
});

test('W: an approval reaches the stream as a card; the person’s answer goes to the app-server, once', async () => {
  const h = await open(fs.mkdtempSync(path.join(base, 'ap-')));
  try {
    const chatId = 'chat-ap';
    await started(h, chatId);
    await h.call('chat.send', chatId, { text: 'approve this' });
    const card = await until(() => h.events(chatId).find((e) => e.kind === 'permission'));
    assert.deepEqual(
      card.options.map((o: any) => o.optionId),
      ['allow_once', 'allow_always', 'reject_once'],
    );
    assert.equal(card.toolCall.title, 'rm -rf build');
    assert.equal(h.sessions.state.snapshot(chatId).turn, 'awaitingUser');
    const answered: any = await h.call('chat.answer', chatId, { requestId: card.requestId, optionId: 'reject_once' });
    assert.deepEqual(answered.result, { answered: true });
    await until(() => h.frames.some((m) => m.frame?.item?.t === 'assistant' && m.frame.item.text.includes('ran: decline')));
    // a second answer is refused: the first one won
    await assert.rejects(
      h.call('chat.answer', chatId, { requestId: card.requestId, optionId: 'allow_once' }),
      (e: any) => e.code === 'card_answered',
    );
    assert.equal(h.requests().filter((r) => r.result?.decision).length, 1);
    await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
  } finally {
    h.close();
  }
});

test('W: a question the Host cannot put to a person (none to ask) is answered as skipped, and the turn goes on', async () => {
  const h = await open(fs.mkdtempSync(path.join(base, 'in-')));
  try {
    const chatId = 'chat-in';
    await started(h, chatId);
    await h.call('chat.send', chatId, { text: 'need input' });
    await until(() => h.frames.some((m) => m.frame?.item?.t === 'assistant' && m.frame.item.text.includes('input: given')));
  } finally {
    h.close();
  }
});

test('B: Codex missing or signed out is refused with harness_not_configured and a setup hint, before a thread or a message is kept', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'b-'));
  const empty = path.join(dir, 'none');
  fs.mkdirSync(empty);
  const h = await open(dir, { PATH: empty, FAKE_CODEX_LOG: path.join(dir, 'codex.jsonl') });
  try {
    const refused = await refusal(h.call('chat.start', 'chat-b', { harness: 'codex', text: 'hi', cwd: dir }));
    assert.equal(refused.code, 'harness_not_configured');
    assert.equal(refused.message, NOT_INSTALLED);
    // a message to an existing chat is refused the same way, before it is queued
    const sent = await refusal(h.call('chat.send', 'chat-b', { text: 'hi' }));
    assert.equal(sent.code, 'harness_not_configured');
    assert.equal(h.sessions.chats.records.has('chat-b'), false);
    assert.equal(h.sessions.state.snapshot('chat-b').queue?.length ?? 0, 0);
    assert.deepEqual(h.requests(), []);
    // the status the app reads says so too
    const status = await listHarnesses({ env: { PATH: empty }, which, acp: [] });
    assert.deepEqual(status[1], { id: 'codex', detected: false, signedIn: false });
  } finally {
    h.close();
  }
  // installed but signed out: the hint is the sign-in
  const out = await open(fs.mkdtempSync(path.join(base, 'b2-')), installCodex(fs.mkdtempSync(path.join(base, 'b3-')), 'out').env);
  try {
    const refused = await refusal(out.call('chat.start', 'chat-b2', { harness: 'codex', text: 'hi', cwd: out.dir }));
    assert.equal(refused.code, 'harness_not_configured');
    assert.equal(refused.message, NOT_SIGNED_IN);
    assert.equal(out.requests().filter((r) => r.method === 'thread/start').length, 0);
  } finally {
    out.close();
  }
});

test('B: Codex installed after the Host started works without a restart; a chat id of another family is refused', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'late-'));
  const env = { PATH: path.join(dir, 'bin'), FAKE_CODEX_LOGIN: 'in', FAKE_CODEX_LOG: path.join(dir, 'codex.jsonl') };
  const h = await open(dir, env);
  try {
    const refused = await refusal(h.call('chat.start', 'chat-late', { harness: 'codex', text: 'hi', cwd: dir }));
    assert.equal(refused.code, 'harness_not_configured');
    installCodex(dir);
    const wrong = await refusal(h.call('chat.start', 'claude:late', { harness: 'codex', text: 'hi', cwd: dir }));
    assert.match(wrong.message, /does not belong to the harness/);
    const ok: any = await h.call('chat.start', 'chat-late', { harness: 'codex', text: 'hi', cwd: dir });
    assert.equal(ok.result.action, 'started');
  } finally {
    h.close();
  }
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('I: the app-server quitting mid-turn ends the turn with the reason, keeps the queue, and the next message starts a new app-server', async () => {
  const h = await open(fs.mkdtempSync(path.join(base, 'crash-')));
  try {
    const chatId = 'chat-crash';
    await started(h, chatId);
    await h.call('chat.send', chatId, { text: 'please crash' });
    const queued: any = await h.call('chat.send', chatId, { text: 'kept' });
    assert.equal(queued.result.action, 'queued');
    const end = await until(() => endedTurns(h, chatId).find((e) => e.stopReason === 'error'));
    assert.match(end.error.message, /Codex quit while working/);
    await until(() => h.sessions.state.snapshot(chatId).turn === 'crashed');
    assert.match(h.sessions.state.snapshot(chatId).crashed, /Codex quit while working/);
    // a chat whose harness quit is not holding up an update restart
    assert.equal(h.sessions.idle(), true);
    assert.deepEqual(
      h.sessions.state.snapshot(chatId).queue.map((q: any) => q.text),
      ['kept'],
    );
    // while Codex is down a message is refused and says why (the Host does not keep what it cannot start: the person sends it again, #4786); once the adapter has restarted the app-server, a message resumes the thread on it
    await assert.rejects(
      h.call('chat.send', chatId, { text: 'early' }),
      (e: any) => e.code === 'unsupported' && /isn't connected/.test(e.message),
    );
    assert.deepEqual(
      h.sessions.state.snapshot(chatId).queue.map((q: any) => q.text),
      ['kept'],
    );
    const codex = h.sessions.controller.codex;
    await until(() => !codex.down && codex.readyAt);
    await h.call('chat.send', chatId, { text: 'again' });
    await until(() => h.frames.some((m) => m.frame?.item?.t === 'assistant' && m.frame.item.text === 'codex: again'));
    // the new turn ran on another process than the first turn did
    const turnStarts = h.requests().filter((r) => r.method === 'turn/start');
    assert.notEqual(turnStarts.at(-1)!.pid, turnStarts[0].pid);
    const turnIds = h
      .events(chatId)
      .filter((e) => e.kind === 'turnStart')
      .map((e) => e.turnId);
    assert.equal(new Set(turnIds).size, turnIds.length, 'a restarted app-server must mint distinct native turn identities');
    assert.ok(h.requests().some((r) => r.method === 'thread/resume'));
  } finally {
    h.close();
  }
});

test('I: a Host that closes mid-turn takes its app-server with it, and a Host started on the same data dir resumes the chat’s thread', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'restart-'));
  const first = await open(dir);
  const chatId = 'chat-restart';
  await started(first, chatId);
  await first.call('chat.send', chatId, { text: 'slow work' });
  await until(() => first.sessions.state.snapshot(chatId).turn === 'running');
  const thread = first.sessions.controller.ref(chatId).id;
  const pid = first.requests().at(-1)!.pid;
  assert.ok(alive(pid));
  assert.equal(first.sessions.idle(), false);
  first.close();
  await until(() => !alive(pid));

  const second = await open(dir);
  try {
    // the chat is known again from the Host's own records; no turn is running
    assert.equal(second.sessions.controller.ref(chatId).id, thread);
    assert.equal(second.sessions.idle(), true);
    await second.call('chat.subscribe', chatId);
    await second.call('chat.send', chatId, { text: 'continue' });
    await until(() => second.frames.some((m) => m.frame?.item?.t === 'assistant' && m.frame.item.text === 'codex: continue'));
    const resumed = second.requests().filter((r) => r.method === 'thread/resume' && r.pid !== pid);
    assert.equal(resumed[0].params.threadId, thread);
  } finally {
    second.close();
  }
});

test('B: a Host without the Codex family, or a harness no family starts, refuses explicitly', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'un-'));
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {} });
  const bare = createHostSessions({ paths, env: {}, runtime });
  try {
    await assert.rejects(bare.chatRuntime.prepare({ chatId: 'c', harness: 'codex' }), (e: any) => e.code === 'unsupported');
    await assert.rejects(bare.chatRuntime.setMode({ chatId: 'c', value: 'read-only' }), (e: any) => e.code === 'unsupported');
  } finally {
    bare.close();
    runtime.close();
  }
  const h = await open(fs.mkdtempSync(path.join(base, 'un2-')));
  try {
    const refused = await refusal(
      h.call('chat.start', 'claude:00000000-0000-4000-8000-0000000000c1', { harness: 'claude', text: 'hi', cwd: h.dir }),
    );
    assert.equal(refused.code, 'unsupported');
  } finally {
    h.close();
  }
});

test('a side chat keeps its Codex conversation when the Host and app-server restart', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'side-restart-'));
  const child = `side-chat-${crypto.randomUUID()}`;
  const parent = 'parent';
  const openSaved = () => open(dir, { ...installCodex(dir).env, FAKE_CODEX_FORKS: '1' }, undefined, undefined, { dataDir: dir });
  const first = await openSaved();
  let thread: string;
  try {
    const { cwd } = await started(first, parent);
    await first.call('chat.subscribe', child);
    await first.call('chat.start', child, { harness: 'codex', cwd, text: 'explain that', sideChat: { sourceId: parent, epoch: 1 } });
    await until(() => first.frames.some((m) => m.chatId === child && m.frame?.item?.t === 'assistant'));
    thread = first.sessions.controller.ref(child).id;
    const fork = first.requests().find((r) => r.method === 'thread/fork');
    assert.equal(fork?.params.ephemeral, false);
    assert.equal(fork?.params.threadId, first.sessions.controller.ref(parent).id);
  } finally {
    first.close();
  }

  const second = await openSaved();
  try {
    await second.call('chat.subscribe', child);
    await second.call('chat.send', child, { text: 'continue the side chat' });
    await until(() => second.frames.some((m) => m.frame?.item?.text === 'codex: continue the side chat'));
    assert.equal(second.sessions.controller.ref(child).id, thread);
    assert.ok(second.requests().some((r) => r.method === 'thread/resume' && r.params.threadId === thread));
  } finally {
    second.close();
  }
});

test('A: a chat started without a folder runs in the Host’s data dir', async () => {
  const h = await open(fs.mkdtempSync(path.join(base, 'nocwd-')));
  try {
    await h.call('chat.subscribe', 'chat-nocwd');
    await h.call('chat.start', 'chat-nocwd', { harness: 'codex', text: 'hi' });
    await until(() => h.frames.some((m) => m.frame?.item?.t === 'assistant'));
    assert.equal(h.requests().find((r) => r.method === 'thread/start').params.cwd, h.dir);
  } finally {
    h.close();
  }
});

const turnStarts = (h: Awaited<ReturnType<typeof open>>) => h.requests().filter((r) => r.method === 'turn/start');

test('A: a message’s model and effort are the turn’s, and the permission a chat was given holds for its later turns', async () => {
  const h = await open(fs.mkdtempSync(path.join(base, 'pick-')));
  try {
    const chatId = 'chat-pick';
    await h.call('chat.subscribe', chatId);
    // a chat that starts in a mode and with a pick: both are the first turn's
    await h.call('chat.start', chatId, {
      harness: 'codex',
      text: 'hi',
      cwd: h.dir,
      permission: 'full-access',
      model: 'gpt-other',
      effort: 'low',
    });
    await until(() => h.sessions.state.snapshot(chatId).turn === 'idle' && turnStarts(h).length === 1);
    const first = turnStarts(h)[0].params;
    assert.equal(first.approvalPolicy, 'never');
    assert.equal(first.collaborationMode.settings.model, 'gpt-other');
    assert.equal(first.collaborationMode.settings.reasoning_effort, 'low');
    // a later message with no pick runs in the chat's mode, with the defaults of the model list
    await h.call('chat.send', chatId, { text: 'again' });
    await until(() => turnStarts(h).length === 2 && h.sessions.state.snapshot(chatId).turn === 'idle');
    assert.equal(turnStarts(h)[1].params.approvalPolicy, 'never');
    assert.equal(turnStarts(h)[1].params.collaborationMode.settings.model, 'gpt-fake');
    // chat.permit changes the mode for the turns after it
    const lane: unknown[] = [];
    h.sessions.events.on('event', (e: any) => e.kind === 'state' && 'permission' in e.patch && lane.push([e.chatId, e.patch]));
    const set: any = await h.call('chat.permit', chatId, { value: 'read-only' });
    assert.deepEqual(set.result, { permission: 'read-only', plan: false });
    await h.call('chat.send', chatId, { text: 'third', model: 'gpt-fake', effort: 'high' });
    await until(() => turnStarts(h).length === 3);
    assert.equal(turnStarts(h)[2].params.sandboxPolicy.type, 'readOnly');
    assert.equal(turnStarts(h)[2].params.collaborationMode.settings.reasoning_effort, 'high');
    assert.equal(turnStarts(h)[2].params.collaborationMode.mode, 'default');
    // Plan is the agent's plan mode on the mode the chat was in; the reply says so, and the turn after it plans
    await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
    const planned: any = await h.call('chat.permit', chatId, { value: 'plan' });
    assert.deepEqual(planned.result, { permission: 'plan', plan: true });
    await h.call('chat.send', chatId, { text: 'fourth' });
    await until(() => turnStarts(h).length === 4);
    assert.equal(turnStarts(h)[3].params.collaborationMode.mode, 'plan');
    // its tools keep the mode it was in before Plan
    assert.equal(turnStarts(h)[3].params.sandboxPolicy.type, 'readOnly');
    // any other mode leaves Plan
    await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
    const left: any = await h.call('chat.permit', chatId, { value: 'default' });
    assert.deepEqual(left.result, { permission: 'default', plan: false });
    await h.call('chat.send', chatId, { text: 'fifth' });
    await until(() => turnStarts(h).length === 5);
    assert.equal(turnStarts(h)[4].params.collaborationMode.mode, 'default');
    // every client that reads the chat's lane is told the mode the Host holds, each time it changes
    assert.deepEqual(lane, [
      [chatId, { permission: 'read-only', plan: false }],
      [chatId, { permission: 'plan', plan: true }],
      [chatId, { permission: 'default', plan: false }],
    ]);
  } finally {
    h.close();
  }
});

test('B: a permission mode Codex does not have is refused, and so is a mode for an ACP chat the agent has no session for', async () => {
  const h = await open(fs.mkdtempSync(path.join(base, 'mode-')));
  try {
    const chatId = 'chat-mode';
    await started(h, chatId);
    const bad = await refusal(h.call('chat.permit', chatId, { value: 'bogus' }));
    assert.match(bad.message, /isn't one Codex has/);
    const other = await refusal(h.call('chat.permit', 'acp:fake:x', { value: 'read-only' }));
    assert.equal(other.code, 'mode_unavailable', 'an ACP chat with no session has no mode to set');
    assert.equal(h.sessions.chats.get(chatId)?.meta.config?.permission ?? null, null);
  } finally {
    h.close();
  }
});

test('A: a turn’s items reach the stream as the ACP updates the app draws: thinking, a command and its output, the plan, file changes, a tool call, a search and token usage', async () => {
  const h = await open(fs.mkdtempSync(path.join(base, 'items-')));
  try {
    const chatId = 'chat-items';
    await started(h, chatId);
    await h.call('chat.send', chatId, { text: 'use tools' });
    await until(() => h.frames.some((m) => m.frame?.item?.t === 'assistant' && m.frame.item.text === 'done'));
    const toolTurn = h.events(chatId).findLast((e) => e.kind === 'turnStart');
    assert.ok(toolTurn, 'the tool turn starts before its updates');
    const updates = h
      .events(chatId)
      .filter((e) => e.kind === 'update' && e.turnId === toolTurn.turnId)
      .map((e) => e.update);
    const message = updates.at(-1);
    assert.equal(message.sessionUpdate, 'agent_message_chunk');
    assert.deepEqual(
      updates.map((u) => [u.sessionUpdate, u.toolCallId ?? u.messageId ?? '', u.status ?? '']),
      [
        ['agent_thought_chunk', 'rs-1', ''],
        ['tool_call', 'cmd-1', 'in_progress'],
        ['tool_call_update', 'cmd-1', 'completed'],
        ['plan', '', ''],
        ['tool_call', 'fc-1', 'in_progress'],
        ['tool_call_update', 'fc-1', 'completed'],
        ['tool_call', 'mcp-1', 'completed'],
        ['tool_call', 'ws-1', 'in_progress'],
        ['tool_call_update', 'ws-1', 'completed'],
        ['usage_update', '', ''],
        ['agent_message_chunk', message.messageId, ''],
      ],
    );
    const by = (id: string, kind: string) => updates.find((u) => u.toolCallId === id && u.sessionUpdate === kind);
    assert.deepEqual(
      [by('cmd-1', 'tool_call').title, by('cmd-1', 'tool_call').kind, by('cmd-1', 'tool_call_update').rawOutput.exitCode],
      ['ls -l', 'execute', 0],
    );
    assert.equal(by('cmd-1', 'tool_call_update').content[0].content.text, 'total 0\n');
    assert.deepEqual(
      updates.find((u) => u.sessionUpdate === 'plan').entries.map((e: any) => e.status),
      ['completed', 'in_progress', 'pending'],
    );
    // a file change is an edit with the patch the app's Undo and diff cards read, headers and line numbers included
    const edit = by('fc-1', 'tool_call_update');
    assert.equal(by('fc-1', 'tool_call').kind, 'edit');
    assert.equal(by('fc-1', 'tool_call').title, 'Edit 2 files');
    assert.match(
      edit.rawOutput.metadata.diff,
      /^--- a\/\/work\/b\.txt\n\+\+\+ b\/\/work\/b\.txt\n@@ -1,2 \+1,2 @@\n keep\n-old\n\+new\n\n--- \/dev\/null\n\+\+\+ b\/\/work\/a\.txt\n@@ -0,0 \+1,1 @@\n\+hello$/,
    );
    // a tool call heard only when it ended arrives whole, with its server and tool in the title and its result as content
    assert.equal(by('mcp-1', 'tool_call').title, 'mcp__sage__echo');
    assert.equal(by('mcp-1', 'tool_call').content[0].content.text, 'echoed');
    assert.deepEqual(
      updates.find((u) => u.sessionUpdate === 'usage_update'),
      { sessionUpdate: 'usage_update', used: 42, size: 1000 },
    );
    // the thread's name and an error that will be retried are the Host's, not the chat's
    assert.equal(JSON.stringify(h.frames).includes('not a thing a chat draws'), false);
    assert.equal(JSON.stringify(h.frames).includes('rate limited'), false);
  } finally {
    h.close();
  }
});
