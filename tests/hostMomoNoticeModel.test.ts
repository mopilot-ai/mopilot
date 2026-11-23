// The tool-less reading turn on a Host (host/src/momoNoticeModel.mjs): a fresh data-only background chat, the turn's words as the answer, and a tool call, a timeout, a cancel or a failed turn ends it with an error; the chat is stopped and removed every way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
// @ts-ignore: plain ESM without declarations
import { createNoticeModel, NOTICE_TAG, READ_TIMEOUT_MS } from '../host/src/momoNoticeModel.mjs';

function rig(
  over: { main?: any; start?: (p: any) => unknown; asHost?: (m: string, p: any) => unknown; timeoutMs?: number; cheap?: any } = {},
) {
  const events = new EventEmitter();
  const calls: any[] = [];
  const reports: string[] = [];
  const chats = {
    main: () => ('main' in over ? over.main : { chatId: 'claude:main', harness: 'claude' }),
    startBackground: (harness: string, tag: string) => (calls.push(['startBackground', harness, tag]), 'claude:bg1'),
    workspace: '/ws',
  };
  const protocol = {
    startScheduled: async (p: any) => (calls.push(['startScheduled', p]), over.start?.(p)),
    asHost: async (method: string, p: any) => (calls.push([method, p.chatId]), over.asHost?.(method, p)),
  };
  const model = createNoticeModel({
    chats,
    protocol,
    events,
    report: (m: string) => reports.push(m),
    ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}),
    ...(over.cheap ? { cheap: over.cheap } : {}),
    ...(over.cheap ? { cheap: over.cheap } : {}),
  });
  const say = (e: object) => events.emit('event', { key: 'claude:bg1', ...e });
  return { model, events, calls, reports, say };
}
const words = (text: string) => ({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { text } } });
const end = { kind: 'turnEnd', stopReason: 'end_turn' };

test('the turn runs in a data-only background chat on the main harness and its words are the answer; the chat is stopped and removed', async () => {
  const r = rig({
    start: () => {
      r.say({ kind: 'turnStart' });
      r.say(words('{"verdict":'));
      r.say({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk' } });
      r.say({
        kind: 'update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { text: 'ignored sub-agent' },
          _meta: { claudeCode: { parentToolUseId: 'x' } },
        },
      });
      r.say({ key: 'other-chat', ...words('NOT MINE') });
      r.say(words('"quiet"}'));
      r.say(end);
    },
  });
  assert.equal(r.model.name, 'momo-background');
  assert.equal(await r.model.complete('PROMPT'), '{"verdict":"quiet"}');
  assert.deepEqual(r.calls[0], ['startBackground', 'claude', NOTICE_TAG]);
  assert.deepEqual(r.calls[1][1], {
    chatId: 'claude:bg1',
    task: { harness: 'claude', prompt: 'PROMPT', cwd: '/ws', projectId: null, onApproval: 'wait', model: 'haiku', effort: 'low' },
  });
  assert.deepEqual(r.calls.slice(2), [
    ['chat.stop', 'claude:bg1'],
    ['chat.remove', 'claude:bg1'],
  ]);
  assert.equal(r.events.listenerCount('event'), 0);
});

test('an ACP harness is named without its prefix; no main chat means no reading', async () => {
  const acp = rig({ main: { chatId: 'acp:x:1', harness: 'acp:gemini' }, start: () => acp.say(end) });
  await acp.model.complete('p');
  assert.equal(acp.calls[1][1].task.harness, 'gemini');
  await assert.rejects(rig({ main: null }).model.complete('p'), /no main chat/);
});

test('a tool call ends the reading, a turn that did not finish fails it, and a start that fails is the error', async () => {
  const tool = rig({ start: () => tool.say({ kind: 'update', update: { sessionUpdate: 'tool_call' } }) });
  await assert.rejects(tool.model.complete('p'), /asked for a tool/);
  assert.deepEqual(
    tool.calls.slice(-2).map((c) => c[0]),
    ['chat.stop', 'chat.remove'],
  );
  const bad = rig({ start: () => bad.say({ kind: 'turnEnd', stopReason: 'cancelled' }) });
  await assert.rejects(bad.model.complete('p'), /did not finish/);
  const errored = rig({ start: () => errored.say({ kind: 'turnEnd', stopReason: 'end_turn', error: 'boom' }) });
  await assert.rejects(errored.model.complete('p'), /did not finish/);
  const refused = rig({
    start: () => {
      throw new Error('the harness is signed out');
    },
  });
  await assert.rejects(refused.model.complete('p'), /signed out/);
  assert.deepEqual(refused.calls.slice(-1)[0], ['chat.remove', 'claude:bg1']);
});

test('a reading that takes too long, or is cancelled by the caller, is stopped', async () => {
  const slow = rig({ timeoutMs: 20 });
  await assert.rejects(slow.model.complete('p'), /took too long/);
  const controller = new AbortController();
  const cancelled = rig({ start: () => queueMicrotask(() => controller.abort()) });
  await assert.rejects(cancelled.model.complete('p', controller.signal), /cancelled/);
  assert.equal(READ_TIMEOUT_MS, 120_000);
});

test('a stop or a removal that fails does not hide the answer; a failed removal is reported', async () => {
  const r = rig({
    start: () => r.say(end),
    asHost: (method) => {
      throw new Error(`${method} failed`);
    },
  });
  assert.equal(await r.model.complete('p'), '');
  assert.deepEqual(r.reports, ['A reading chat could not be removed: chat.remove failed']);
});

test('made with only its parts, it uses its own timeout and a silent report', async () => {
  const events = new EventEmitter();
  const model = createNoticeModel({
    chats: { main: () => ({ chatId: 'c', harness: 'claude' }), startBackground: () => 'claude:bg1', workspace: '/w' },
    protocol: {
      startScheduled: async () => void events.emit('event', { key: 'claude:bg1', kind: 'turnEnd', stopReason: 'end_turn' }),
      asHost: async (method: string) => {
        if (method === 'chat.remove') throw new Error('gone');
      },
    },
    events,
  });
  assert.equal(await model.complete('p'), '');
});

test('the reading runs on the cheap model of the harness at low effort, never the main chat model; a harness that names none keeps its own', async () => {
  const claude = rig({ start: () => claude.say(end) });
  await claude.model.complete('p');
  assert.deepEqual([claude.calls[1][1].task.model, claude.calls[1][1].task.effort], ['haiku', 'low']);
  const acp = rig({ main: { chatId: 'acp:x:1', harness: 'acp:gemini' }, start: () => acp.say(end) });
  await acp.model.complete('p');
  assert.equal('model' in acp.calls[1][1].task, false);
  assert.equal(acp.calls[1][1].task.effort, 'low');
  const none = rig({ start: () => none.say(end), cheap: async () => ({}) });
  await none.model.complete('p');
  assert.deepEqual(Object.keys(none.calls[1][1].task).sort(), ['cwd', 'harness', 'onApproval', 'projectId', 'prompt']);
});
