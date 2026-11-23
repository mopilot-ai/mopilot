// Claude's agent page and tasks pane, renderer side: live child transcripts reach the agent thread store
// (src/session/harness/claude.ts), stored ones load through loadClaudeAgentThread, task output and stop (src/session/harness/claudeAgents.ts).
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';
import { subagentReply } from './support/claude-translate.ts';

// startClaude's usage refresher and reaper would keep the test process alive
const realInterval = globalThis.setInterval;
globalThis.setInterval = (() => ({ unref() {} })) as any;
after(() => void (globalThis.setInterval = realInterval));

const claude = await import('../src/session/harness/claude.ts');
const { loadClaudeAgentThread, readClaudeTaskOutput } = await import('../src/session/harness/claudeAgents.ts');
const { agentThread, loadAgentThread, putAgentItems, setAgentThreadLoaderResolver } = await import('../src/store/agentThreads.ts');

const AID = 'a0123456789abcdef';
let onItems: (e: any) => void;
const asked: any[] = [];
beforeEach(() => {
  reset();
  asked.length = 0;
  fx.native.claude = {
    onEvent: () => {},
    onItems: (h: any) => (onItems = h),
    onAccountsEvent: () => {},
    onCatalog: () => {},
    accounts: async () => ({ active: 'default', accounts: [] }),
    detect: async () => ({ state: 'signin', bin: null }),
    control: async (...a: any[]) => {
      asked.push(['control', ...a]);
      if (a[2] === 'bad') throw new Error('not running');
      if (a[2] === 'gone') return null;
      if (a[1] === 'backgroundTasks') {
        if (a[0] === 'claude:err') throw new Error('disabled');
        if (a[0] === 'claude:odd') throw 'refused';
        return a[0] === 'claude:fg';
      }
    },
    subagentItems: async (sessionId: string, agentId: string, o: any) => {
      asked.push(['subagentItems', sessionId, agentId, o.dir]);
      if (sessionId !== 'old') return null;
      const stored = {
        type: 'assistant',
        uuid: 's1',
        message: { model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }] },
      };
      return subagentReply([stored], o.chatId, o.cwd, o.settled);
    },
    taskOutput: async (...a: any[]) => (asked.push(['taskOutput', ...a]), 'tail'),
  };
});

const run = (extra: object = {}): any => ({
  key: 'ag',
  description: 'Explore',
  prompt: null,
  model: null,
  background: false,
  status: 'completed',
  toolUses: 0,
  latestTool: null,
  tokens: null,
  startedAt: null,
  completedAt: null,
  report: null,
  transcript: 'full',
  agentId: AID,
  ...extra,
});

test("a live sub-agent's steps from main go to the agent page's store under the chat, not into the thread", async () => {
  claude.startClaude();
  await tick();
  const chat = 'claude:live';
  fx.state.threads[chat] = { id: chat, cwd: '/repo' };
  const items = [{ type: 'agentMessage', id: 's1', text: 'Looking.' }];
  onItems({
    chatId: chat,
    key: chat,
    method: 'agent/items',
    params: { threadId: chat, agentKey: 'ag', items: new TextEncoder().encode(JSON.stringify(items)) },
  });
  const thread = agentThread(chat, 'ag');
  assert.deepEqual([thread.live, thread.items.map((i) => i.text)], [true, ['Looking.']]);
});

test('a stored transcript: the newest Claude session with it, the chat folder first, open tools cut off once settled', async () => {
  const chat = 'claude:new';
  fx.state.threads[chat] = { id: chat, cwd: '/repo' };
  fx.state.segments[chat] = [
    { harness: 'claude', nativeId: 'claude:old' },
    { harness: 'codex', nativeId: 'thr' },
    { harness: 'claude', nativeId: 'claude:new' },
  ];
  const result = (await loadClaudeAgentThread(chat, run())) as any;
  const items = result.items;
  assert.deepEqual(
    items.map((i: any) => [i.id, i.status]),
    [['b', 'failed']],
  );
  assert.deepEqual(
    asked.map((a) => a.slice(0, 4)),
    [
      ['subagentItems', 'new', AID, '/repo'],
      ['subagentItems', 'old', AID, '/repo'],
    ],
  );
  // the stored transcript names the model the agent ran on; one that names none leaves it unset
  assert.equal(result.model, 'Haiku 5.5');
  // still running: its open tool is still running; a chat with no segments is its own session; nothing found is empty
  assert.equal(((await loadClaudeAgentThread(chat, run({ status: 'running' }))) as any).items[0].status, 'inProgress');
  asked.length = 0;
  assert.deepEqual(await loadClaudeAgentThread('claude:solo', run()), []);
  assert.deepEqual(asked, [['subagentItems', 'solo', AID, null]]);
  assert.deepEqual(await loadClaudeAgentThread('codex-chat', run()), []);
  await assert.rejects(loadClaudeAgentThread(chat, run({ agentId: null })), /no transcript/);
});

test("a task's output is read from its file; one without a file has none; a stop says whether it went", async () => {
  const shell: any = { id: 'b1', output: { kind: 'file', path: '/t/tasks/b1.output' } };
  assert.equal(await readClaudeTaskOutput(shell), 'tail');
  assert.equal(await readClaudeTaskOutput({ ...shell, output: { kind: 'process', id: 'p' } }), null);
  assert.equal(await readClaudeTaskOutput({ ...shell, output: null }), null);
  assert.deepEqual(asked, [['taskOutput', 'b1', '/t/tasks/b1.output']]);
  asked.length = 0;
  assert.equal(await claude.stopClaudeTask('claude:x', { id: 'ok' } as any), true);
  assert.equal(await claude.stopClaudeTask('claude:x', { id: 'bad' } as any), false);
  // no running session: main answers null, which is not a stop
  assert.equal(await claude.stopClaudeTask('claude:x', { id: 'gone' } as any), false);
  assert.ok(called('toast').some(([text]) => /session isn't running/.test(text)));
  assert.deepEqual(
    asked.map((a) => a.slice(0, 4)),
    [
      ['control', 'claude:x', 'stopTask', 'ok'],
      ['control', 'claude:x', 'stopTask', 'bad'],
      ['control', 'claude:x', 'stopTask', 'gone'],
    ],
  );
  assert.ok(called('toast').some(([text]) => /Couldn't stop the task: not running/.test(text)));
});

test('moving work to the background says when nothing ran in the foreground or the CLI refused', async () => {
  assert.equal(await claude.claudeMoveToBackground('claude:fg'), true);
  assert.equal(called('toast').length, 0);
  assert.equal(await claude.claudeMoveToBackground('claude:idle'), false);
  assert.ok(called('toast').some(([text]) => text === 'Nothing is running in the foreground'));
  assert.equal(await claude.claudeMoveToBackground('claude:err'), false);
  assert.ok(called('toast').some(([text]) => /Couldn't move it to the background: disabled/.test(text)));
  // a rejection that is no Error is reported as it is
  assert.equal(await claude.claudeMoveToBackground('claude:odd'), false);
  assert.ok(called('toast').some(([text]) => /to the background: refused/.test(text)));
});

test('a historical agent with a known owner reads only that native session', async () => {
  const chat = 'current-codex-chat';
  fx.state.segments[chat] = [
    { harness: 'claude', nativeId: 'claude:old' },
    { harness: 'claude', nativeId: 'claude:new' },
    { harness: 'codex', nativeId: 'current-codex-chat' },
  ];
  const items = await loadClaudeAgentThread(chat, run({ source: { kind: 'claude', key: 'claude:old' } }));
  assert.equal((items as any).items[0].id, 'b');
  assert.deepEqual(asked, [['subagentItems', 'old', AID, null]]);
});

test('a late stored Claude model cannot replace the live transcript metadata', async () => {
  const chat = 'claude:model-race';
  let finish!: (reply: Buffer) => void;
  fx.native.claude.subagentItems = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  setAgentThreadLoaderResolver(() => loadClaudeAgentThread);
  const pending = loadAgentThread(chat, run());
  putAgentItems(chat, 'ag', [{ type: 'agentMessage', id: 'live', text: 'Current steps' }]);
  const live = agentThread(chat, 'ag');
  finish(
    subagentReply(
      [{ type: 'assistant', uuid: 'old', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Old steps' }] } }],
      chat,
      '',
    ),
  );
  await pending;
  assert.equal(agentThread(chat, 'ag'), live);
  assert.equal(live.model, null);
});

test('an owned stored load commits Claude items and their model together', async () => {
  const chat = 'claude:stored-model';
  fx.state.segments[chat] = [{ harness: 'claude', nativeId: 'claude:old' }];
  setAgentThreadLoaderResolver(() => loadClaudeAgentThread);
  await loadAgentThread(chat, run());
  assert.equal(agentThread(chat, 'ag').model, 'Haiku 5.5');
  assert.equal(agentThread(chat, 'ag').items[0].id, 'b');
});

test('a line of a stored transcript that could not be read is noted and costs only itself', async () => {
  const chat = 'claude:stored-unread';
  fx.native.claude.subagentItems = async () =>
    subagentReply([{ type: 'assistant', uuid: 'one', message: { content: [{ type: 'tool_use', id: 'x', name: 7 }] } }, 5], chat, '');
  setAgentThreadLoaderResolver(() => loadClaudeAgentThread);
  await loadAgentThread(chat, run());
  assert.deepEqual(agentThread(chat, 'ag').items, []);
});

test('a stored transcript without a model still commits its steps', async () => {
  const chat = 'claude:stored-no-model';
  fx.native.claude.subagentItems = async () =>
    subagentReply([{ type: 'assistant', uuid: 'one', message: { content: [{ type: 'text', text: 'Steps' }] } }], chat, '');
  setAgentThreadLoaderResolver(() => loadClaudeAgentThread);
  await loadAgentThread(chat, run());
  assert.equal(agentThread(chat, 'ag').model, null);
  assert.equal(agentThread(chat, 'ag').items[0].text, 'Steps');
});

test("Stop on a Claude chat passes main's id for the turn a button showed and returns main's answer (#1866)", async () => {
  const stops: any[] = [];
  fx.native.session = { claudeStop: async (...a: any[]) => (stops.push(a), a[1] === 'old' ? 'retired' : true) };
  assert.equal(await claude.claudeStop('claude:x', 'old'), 'retired');
  assert.equal(await claude.claudeStop('claude:x'), true);
  assert.deepEqual(stops, [
    ['claude:x', 'old'],
    ['claude:x', undefined],
  ]);
});
