// A chat kept apart from the coding side (MoMo's, #2139) runs without the harness's own memory and the user's
// instructions where the harness allows: Codex turns its thread's memory off before the first turn or goal (and runs
// nothing when it can't), Claude Code starts with no CLAUDE.md and no auto memory. Other chats are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, settle } from './support/codex-harness/fixture.ts';

const require = createRequire(import.meta.url);
const { CodexIsolation } = require('../electron/harness/codexIsolation.cjs');
const { isolateOptions, ISOLATED_ENV } = require('../electron/harness/claude/isolation.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
const { createState } = require('../electron/harness/claude/state.cjs');
const claude = require('../electron/harness/claude/index.cjs').createClaudeHarness();

const ref = (id: string) => ({ kind: 'codex', id });
const MEMORY_OFF = 'thread/memoryMode/set';

test('Codex: every model run of an isolated chat goes with its thread memory off, each time; other chats are untouched', async () => {
  const { a, server } = setup({ 'review/start': () => ({}) }, { isolated: (chatId: string) => chatId.startsWith('momo') });
  await a.startTurn('momo1', ref('momo1'), { text: 'hi' });
  await a.startTurn('momo1', ref('momo1'), { text: 'again' });
  await a.request('review/start', { threadId: 'momo1', target: {}, delivery: 'inline' });
  await a.request('turn/steer', { threadId: 'momo1', input: [] }).catch(() => undefined);
  await a.request('thread/goal/set', { threadId: 'momo1', status: 'paused' });
  await a.request('thread/compact/start', { threadId: 'momo1' });
  await a.startTurn('code', ref('code'), { text: 'code' });
  await a.request('review/start', { threadId: 'code', target: {}, delivery: 'inline' });
  await settle();
  const runs = server
    .methods()
    .filter((m: string) => [MEMORY_OFF, 'turn/start', 'review/start', 'turn/steer', 'thread/compact/start'].includes(m));
  // never cached: an app-server restart or another account can't leave a thread's memory on
  assert.deepEqual(runs, [
    MEMORY_OFF,
    'turn/start',
    MEMORY_OFF,
    'turn/start',
    MEMORY_OFF,
    'review/start',
    MEMORY_OFF,
    'turn/steer',
    MEMORY_OFF,
    'thread/compact/start',
    'turn/start',
    'review/start',
  ]);
  assert.deepEqual(server.params(MEMORY_OFF)[0], { threadId: 'momo1', mode: 'disabled' });
});

test('Codex: nothing turns an isolated chat’s memory back on; turning it off goes through', async () => {
  const { a, server } = setup({}, { isolated: (chatId: string) => chatId === 'momo1' });
  await assert.rejects(a.request(MEMORY_OFF, { threadId: 'momo1', mode: 'enabled' }), /Codex memory stays off in MoMo's chats/);
  await a.request(MEMORY_OFF, { threadId: 'momo1', mode: 'disabled' });
  await a.request(MEMORY_OFF, { threadId: 'code', mode: 'enabled' });
  await a.request('thread/list', {});
  await settle();
  assert.deepEqual(
    server.params(MEMORY_OFF).map((p: any) => [p.threadId, p.mode]),
    [
      ['momo1', 'disabled'],
      ['code', 'enabled'],
    ],
  );
});

test('Codex: a thread whose memory can’t be turned off runs no turn and no goal, says why, and tries again next time', async () => {
  let refuse = true;
  const { a, server, of } = setup(
    {
      [MEMORY_OFF]: () => {
        if (refuse) throw new Error('unknown method');
        return {};
      },
      'thread/goal/set': () => ({ goal: { objective: 'g', status: 'active' } }),
    },
    { isolated: () => true },
  );
  const r = await a.startTurn('momo', ref('t1'), { text: 'hi' });
  assert.equal(r.started, false);
  assert.match(r.error, /Couldn't turn off Codex memory for this chat, so it doesn't run: unknown method/);
  assert.equal(of('turnFailed').length, 1);
  assert.equal(server.methods().includes('turn/start'), false);
  const g = await a.startGoal('momo', ref('t1'), { text: '/goal g', opts: { goal: 'g' } });
  assert.equal(g.started, false);
  assert.equal(server.methods().includes('thread/goal/set'), false);
  refuse = false;
  await a.startGoal('momo', ref('t1'), { text: '/goal g', opts: { goal: 'g' } });
  await settle();
  const order = server.methods().filter((m: string) => m === MEMORY_OFF || m === 'thread/goal/set');
  assert.deepEqual(order, [MEMORY_OFF, MEMORY_OFF, MEMORY_OFF, 'thread/goal/set']);
});

test('CodexIsolation alone: a request with no thread, or for a chat that isn’t isolated, passes untouched', async () => {
  const asked: any[] = [];
  const iso = new CodexIsolation({
    isolated: (c: string) => c === 'm',
    chatOf: (t: string) => (t === 'seg' ? 'm' : t),
    call: async (method: string, params: any) => {
      // the shell check passes: this case is about the memory switch
      if (method === 'config/read') return { config: { features: { shell_tool: false, unified_exec: false, view_image: false } } };
      asked.push([method, params]);
      throw 'down';
    },
  });
  assert.equal(iso.applies({}), false);
  assert.equal(iso.applies(undefined), false);
  assert.equal(iso.applies({ threadId: 'other' }), false);
  assert.equal(iso.applies({ threadId: 'seg' }), true);
  await iso.gate('thread/list', { threadId: 'seg' });
  assert.equal(asked.length, 0);
  // a later segment's thread belongs to the isolated chat
  await assert.rejects(iso.gate('turn/start', { threadId: 'seg' }), /so it doesn't run: down/);
});

test('Claude Code: an isolated chat’s session reads no CLAUDE.md and keeps no auto memory; others start as before', async () => {
  const options: any = { env: { PATH: '/bin' }, settings: { fastMode: true } };
  isolateOptions(options);
  assert.deepEqual(options.env, { PATH: '/bin', ...ISOLATED_ENV });
  assert.equal(ISOLATED_ENV.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(ISOLATED_ENV.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.deepEqual(options.settings, { fastMode: true, autoMemoryEnabled: false });
  const bare: any = {};
  isolateOptions(bare);
  assert.deepEqual(bare.settings, { autoMemoryEnabled: false });

  // through the session's preparation: by the chat the session names, else the chat its key belongs to
  const prepared = async (state: any, opts: any) => {
    const options: any = { env: {} };
    await prepareSessionTools(state, { takesPluginDirs: () => false }, '/cli', options, {}, opts, 'k1', () => 'from-key');
    return options;
  };
  const isolated = (id: string) => id === 'momo' || id === 'from-key';
  assert.equal((await prepared({ isolated }, { chatId: 'momo' })).env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal((await prepared({ isolated }, {})).settings.autoMemoryEnabled, false);
  assert.deepEqual((await prepared({ isolated }, { chatId: 'code' })).env, {});
  // a state no one told about isolation (as before): untouched
  assert.deepEqual((await prepared({}, { chatId: 'momo' })).env, {});
  // main's default says no chat is isolated, and main sets the rule
  assert.equal(createState().isolated('momo'), false);
  const rule = (id: string) => id === 'momo';
  assert.equal(claude.setIsolated(rule), rule);
});

test("Codex: an isolated chat's goal applies the strictest sandbox, whatever permission the chat's composer holds", async () => {
  const { a, server } = setup(
    { 'thread/goal/set': (p: any) => ({ goal: { threadId: p.threadId, objective: p.objective, status: 'active' } }) },
    { isolated: (chatId: string) => chatId.startsWith('momo'), prefs: () => ({ permission: 'full-access' }) },
  );
  await a.startGoal('momo1', ref('momo1'), { text: '/goal g', opts: { goal: 'g' } });
  await a.startGoal('code', ref('code'), { text: '/goal g', opts: { goal: 'g' } });
  await settle();
  const updates = server.sent.filter((m: any) => m.method === 'thread/settings/update').map((m: any) => m.params);
  assert.deepEqual(
    updates.map((p: any) => [p.threadId, p.sandboxPolicy, p.approvalPolicy]),
    [
      ['momo1', { type: 'readOnly', networkAccess: false }, 'never'],
      ['code', { type: 'dangerFullAccess' }, 'never'],
    ],
  );
});

test('CodexIsolation alone: a settings update on an isolated thread keeps the strictest sandbox and drops a named profile', async () => {
  const iso = new CodexIsolation({ isolated: () => true, chatOf: (t: string) => t, call: async () => ({}) });
  assert.deepEqual(
    await iso.gate('thread/settings/update', {
      threadId: 'm',
      model: 'x',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'dangerFullAccess' },
      permissions: 'full',
    }),
    { threadId: 'm', model: 'x', permissions: null, sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' },
  );
  // a settings update that names no permission (the model, the mode) still pins the strictest sandbox
  assert.deepEqual(await iso.gate('thread/settings/update', { threadId: 'm', model: 'x' }), {
    threadId: 'm',
    model: 'x',
    permissions: null,
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    approvalPolicy: 'never',
  });
});
