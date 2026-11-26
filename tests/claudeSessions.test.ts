// Claude Code sessions in the main process (electron/harness/claude/index.cjs), run against a fake Agent SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { waitFor } from './support/waitFor.ts';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claude-sessions-'));
fs.writeFileSync(
  path.join(tmp, 'electron.cjs'),
  `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => String(b).slice(4) } };`,
);
fs.writeFileSync(
  path.join(tmp, 'sdk.mjs'),
  'export const query = (args) => globalThis.__fakeQuery(args);\nexport const getSessionMessages = async (id) => globalThis.__fakeMessages?.(id) ?? [];',
);
const fakes: Record<string, string> = { electron: 'electron.cjs', '@anthropic-ai/claude-agent-sdk': 'sdk.mjs' };
registerHooks({
  resolve(specifier, context, next) {
    if (fakes[specifier]) return { url: pathToFileURL(path.join(tmp, fakes[specifier])).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/** A CLI process: answers each prompt with a result; on close its stream ends, or throws (`closeThrows`). */
interface FakeQuery {
  options: any;
  inputs: any[];
  flags: any[];
  modes: string[];
  stopped: string[];
  rewinds: any[];
  applied: { ultracode: boolean; ultracodeAvailable: boolean };
  closed: boolean;
  close(): void;
  interrupt(): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  getSettings(): Promise<any>;
  rewindFiles(uuid: string, o: any): Promise<any>;
  stopTask(id: string): Promise<void>;
  applyFlagSettings(settings: any): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<any>;
}
const queries: FakeQuery[] = [];
let closeThrows = false;
(globalThis as any).__fakeQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
  const out: any[] = [];
  let wake = () => {};
  const q: FakeQuery = {
    options,
    inputs: [],
    flags: [],
    modes: [],
    stopped: [],
    rewinds: [],
    applied: { ultracode: false, ultracodeAvailable: true },
    closed: false,
    close() {
      q.closed = true;
      wake();
    },
    async interrupt() {},
    async setPermissionMode(mode: string) {
      q.modes.push(mode);
    },
    async getSettings() {
      return { applied: { ...q.applied } };
    },
    async rewindFiles(uuid: string, o: any) {
      q.rewinds.push({ uuid, dryRun: !!o?.dryRun });
      return { canRewind: true, filesChanged: ['/repo/f.txt'] };
    },
    async stopTask(id: string) {
      q.stopped.push(id);
    },
    async applyFlagSettings(settings: any) {
      // as the CLI does (C6): an effort change without ultracode turns it off
      if ('ultracode' in settings) q.applied.ultracode = !!settings.ultracode;
      else if ('effortLevel' in settings) q.applied.ultracode = false;
      q.flags.push(settings);
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) yield out.shift();
        else if (q.closed) {
          if (closeThrows) throw new Error('Claude Code process aborted by user');
          return;
        } else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  (async () => {
    for await (const m of prompt) {
      q.inputs.push(m);
      out.push(
        { type: 'assistant', message: { content: [{ type: 'text', text: `re: ${m.message.content}` }] } },
        { type: 'result', subtype: 'success' },
      );
      wake();
    }
  })();
  queries.push(q);
  return q;
};

const claude = createRequire(import.meta.url)('../electron/harness/claude/index.cjs').createClaudeHarness();
// a CLI that ends (a billing switch, another account) gets this long to run its exit hooks before the SDK closes it
claude.timing.retireMs = 50;
const handlers = new Map<string, (...a: any[]) => any>();
const events: any[] = [];
claude.register(
  { handle: (name: string, fn: (...a: any[]) => any) => handlers.set(name, fn) },
  (channel: string, evt: any) => channel === 'claude:event' && events.push(evt),
);
const call = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);

async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what);
  assert.ok(ok(), `timed out waiting for ${what}`);
}
const results = (key: string) => events.filter((e) => e.key === key && e.kind === 'message' && e.msg.type === 'result').length;
const ends = (key: string) => events.filter((e) => e.key === key && (e.kind === 'closed' || e.kind === 'error'));
const opts = (sessionId: string, account: string) => ({ bin: process.execPath, sessionId, resume: true, cwd: tmp, account });
const msg = (text: string) => ({ role: 'user', content: text });

for (const throws of [false, true]) {
  test(`moving a live chat to another account restarts its CLI without reporting an exit (old stream ${throws ? 'throws' : 'ends'})`, async () => {
    closeThrows = throws;
    const sid = `move-${throws}`;
    const key = `claude:${sid}`;
    const before = queries.length;
    await claude.send(key, opts(sid, 'default'), msg('one'));
    await until('the first reply', () => results(key) === 1);
    await claude.send(key, opts(sid, 'b1'), msg('two'));
    await until('the reply on the new account', () => results(key) === 2);
    const [first, second] = queries.slice(before);
    assert.equal(queries.length - before, 2);
    assert.ok(first.closed);
    assert.equal(second.options.resume, sid);
    assert.deepEqual(ends(key), []);
    assert.equal(claude.turnApi.isLive(key), true);
    await call('claude:control', key, 'close');
  });
}

test('a message sent while the CLI is being replaced goes to the new CLI, not a second one', async () => {
  closeThrows = false;
  const key = 'claude:race';
  const before = queries.length;
  await claude.send(key, opts('race', 'default'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  // the move retires the CLI (its exit hooks get a moment); a steer arrives meanwhile, with no CLI live
  const moving = claude.send(key, opts('race', 'b1'), msg('two'));
  const steer = claude.send(key, opts('race', 'b1'), msg('three'), 'now');
  await Promise.all([moving, steer]);
  await until('both replies', () => results(key) === 3);
  assert.equal(queries.length - before, 2, 'one CLI for the move, none for the steer');
  assert.ok(queries[before].closed);
  assert.equal(claude.turnApi.isLive(key), true);
  await call('claude:control', key, 'close');
});

test('a chat that stays on its account keeps its CLI', async () => {
  closeThrows = false;
  const key = 'claude:same';
  const before = queries.length;
  await claude.send(key, opts('same', 'b1'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  await claude.send(key, opts('same', 'b1'), msg('two'));
  await until('the second reply', () => results(key) === 2);
  assert.equal(queries.length - before, 1);
  await call('claude:control', key, 'close');
});

test('every Claude session asks /code-review for typed findings (ReportFindings), on top of its own environment', async () => {
  assert.equal(claude.buildSessionOptions({ cwd: tmp }, { env: { A: '1' } }).env.CLAUDE_CODE_REPORT_FINDINGS, '1');
  const inherited = claude.buildSessionOptions({ cwd: tmp }, {}).env;
  assert.equal(inherited.CLAUDE_CODE_REPORT_FINDINGS, '1');
  assert.equal(inherited.PATH, process.env.PATH);
  // a chat's CLI gets it along with the account's environment
  closeThrows = false;
  const key = 'claude:findings';
  await claude.send(key, opts('findings', 'b1'), msg('one'));
  await until('the reply', () => results(key) === 1);
  const env = queries.at(-1)!.options.env;
  assert.equal(env.CLAUDE_CODE_REPORT_FINDINGS, '1');
  assert.equal(env.PATH, createRequire(import.meta.url)('../electron/platform/env.cjs').widenPath(process.env.PATH));
  await call('claude:control', key, 'close');
});

test('moving a live chat into or out of read-only restarts its CLI so the tool whitelist matches (D-28)', async () => {
  closeThrows = false;
  const key = 'claude:ro';
  const before = queries.length;
  const o = (permission: string, basePermission = permission) => ({ ...opts('ro', 'b1'), permission, basePermission });
  await claude.send(key, o('default'), msg('one'));
  await until('the first reply', () => results(key) === 1);
  // another mode that needs no whitelist keeps the process
  await claude.send(key, o('full-access'), msg('two'));
  await until('the second reply', () => results(key) === 2);
  assert.equal(queries.length - before, 1);
  await claude.send(key, o('read-only'), msg('three'));
  await until('the reply in read-only', () => results(key) === 3);
  assert.equal(queries.length - before, 2);
  assert.deepEqual(
    queries[before + 1].options.allowedTools,
    claude.buildSessionOptions({ cwd: tmp, permission: 'read-only' }, {}).allowedTools,
  );
  // a plan in a read-only chat is still read-only: same process, and the whitelist is there for after the approval
  await claude.send(key, o('plan', 'read-only'), msg('four'));
  await until('the reply in plan', () => results(key) === 4);
  assert.equal(queries.length - before, 2);
  await claude.send(key, o('default'), msg('five'));
  await until('the reply out of read-only', () => results(key) === 5);
  assert.equal(queries.length - before, 3);
  assert.ok(claude.buildSessionOptions({ cwd: tmp, permission: 'plan', basePermission: 'read-only' }, {}).allowedTools.includes('Read'));
  assert.equal(claude.buildSessionOptions({ cwd: tmp, permission: 'plan', basePermission: 'default' }, {}).allowedTools, undefined);
  await call('claude:control', key, 'close');
});

test('a CLI that ends for any other reason is still reported', async () => {
  for (const throws of [false, true]) {
    closeThrows = throws;
    const key = `claude:end-${throws}`;
    await claude.send(key, opts(`end-${throws}`, 'default'), msg('one'));
    await until('the reply', () => results(key) === 1);
    await call('claude:control', key, 'close');
    await until('the end event', () => ends(key).length === 1);
    assert.equal(ends(key)[0].kind, throws ? 'error' : 'closed');
  }
});

test("sessions start with Claude Code's own system prompt", () => {
  const o = claude.buildSessionOptions({ cwd: tmp, permission: 'default' }, { bin: 'claude' });
  assert.deepEqual([o.systemPrompt.preset, /mcp__mopilot_browser__/.test(o.systemPrompt.append)], ['claude_code', true]);
  assert.equal(o.pathToClaudeCodeExecutable, 'claude');
  assert.equal(o.permissionMode, 'default');
  // Claude in Chrome stays off: browser control is MoPilot's
  assert.deepEqual(o.extraArgs, { 'no-chrome': null });
});

test('only typed messages carry origin human, and every message has a uuid', () => {
  const typed = claude.buildUserMessage(msg('hi'), { human: true, uuid: 'u-1' });
  assert.deepEqual(typed.origin, { kind: 'human' });
  assert.equal(typed.uuid, 'u-1');
  const own = claude.buildUserMessage(msg('Continue where you left off.'));
  assert.equal('origin' in own, false);
  assert.match(own.uuid, /^[0-9a-f-]{36}$/);
  assert.notEqual(claude.buildUserMessage(msg('a')).uuid, own.uuid);
  assert.equal(claude.buildUserMessage(msg('a'), { priority: 'now' }).priority, 'now');
});

test("an effort change keeps the session's ultracode", () => {
  const s: any = {};
  assert.deepEqual(claude.flagSettings(s, { effortLevel: 'high', fastMode: false }), { effortLevel: 'high', fastMode: false });
  assert.deepEqual(claude.flagSettings(s, { ultracode: true }), { ultracode: true });
  assert.deepEqual(claude.flagSettings(s, { effortLevel: 'low', fastMode: false }), {
    effortLevel: 'low',
    fastMode: false,
    ultracode: true,
  });
  claude.flagSettings(s, { ultracode: false });
  assert.deepEqual(claude.flagSettings(s, { effortLevel: 'max' }), { effortLevel: 'max', ultracode: false });
});

test('send passes origin, uuid and flag settings through to the CLI', async () => {
  closeThrows = false;
  const key = 'claude:meta';
  const before = queries.length;
  await claude.send(key, opts('meta', 'default'), msg('typed'), undefined, { human: true, uuid: 'm-1' });
  await until('the first reply', () => results(key) === 1);
  await claude.send(key, opts('meta', 'default'), msg('Continue where you left off.'));
  await until('the second reply', () => results(key) === 2);
  const q = queries[before];
  assert.match(q.options.systemPrompt.append, /mcp__mopilot_browser__/);
  assert.deepEqual(q.inputs[0].origin, { kind: 'human' });
  assert.equal(q.inputs[0].uuid, 'm-1');
  assert.equal(q.inputs[1].origin, undefined);
  assert.ok(q.inputs[1].uuid);
  await call('claude:control', key, 'applyFlagSettings', { ultracode: true });
  await call('claude:control', key, 'applyFlagSettings', { effortLevel: 'low', fastMode: false });
  assert.deepEqual(q.flags.at(-1), { effortLevel: 'low', fastMode: false, ultracode: true });
  await call('claude:control', key, 'close');
});

test("sessions may switch to bypassPermissions later, but start in the chat's own mode", () => {
  for (const permission of ['default', 'plan', 'read-only', 'full-access']) {
    const o = claude.buildSessionOptions({ cwd: tmp, permission }, { bin: 'claude' });
    assert.equal(o.allowDangerouslySkipPermissions, true);
  }
  assert.equal(claude.buildSessionOptions({ cwd: tmp, permission: 'plan' }, {}).permissionMode, 'plan');
  assert.equal(claude.buildSessionOptions({ cwd: tmp, permission: 'full-access' }, {}).permissionMode, 'bypassPermissions');
});

test('an approved plan goes back to the mode before plan; other answers are untouched', () => {
  const allow = { behavior: 'allow', updatedInput: { plan: 'p' } };
  assert.deepEqual(claude.planApproval('ExitPlanMode', allow, 'auto').updatedPermissions, [
    { type: 'setMode', mode: 'auto', destination: 'session' },
  ]);
  assert.deepEqual(claude.planApproval('ExitPlanMode', allow, undefined).updatedPermissions, [
    { type: 'setMode', mode: 'default', destination: 'session' },
  ]);
  const deny = { behavior: 'deny', message: 'no' };
  assert.equal(claude.planApproval('ExitPlanMode', deny, 'auto'), deny);
  assert.equal(claude.planApproval('Bash', allow, 'auto'), allow);
  const own = { ...allow, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] };
  assert.equal(claude.planApproval('ExitPlanMode', own, 'auto'), own);
  assert.equal(claude.restoreMode('plan'), 'default');
  assert.equal(claude.restoreMode('read-only'), 'dontAsk');
  assert.equal(claude.restoreMode('auto-review'), 'auto');
});

test("approving ExitPlanMode returns to the chat's permission, as it is when the card is answered", async () => {
  closeThrows = false;
  const key = 'claude:plan';
  const before = queries.length;
  await claude.send(key, { ...opts('plan', 'default'), permission: 'plan', basePermission: 'auto-review' }, msg('plan it'));
  await until('the reply', () => results(key) === 1);
  const q = queries[before];
  assert.equal(q.options.permissionMode, 'plan');
  const ask = async () => {
    const answer = q.options.canUseTool('ExitPlanMode', { plan: '1. do it', planFilePath: '/p.md' }, { toolUseID: 't1' });
    const fresh = () => events.find((e) => e.key === key && e.kind === 'permission' && !e.seen);
    await until('the approval card', () => !!fresh());
    const card = fresh();
    card.seen = true;
    assert.deepEqual(card.input, { plan: '1. do it', planFilePath: '/p.md' });
    await call('claude:permission', card.requestId, { behavior: 'allow', updatedInput: card.input });
    return answer;
  };
  assert.deepEqual((await ask()).updatedPermissions, [{ type: 'setMode', mode: 'auto', destination: 'session' }]);
  // the chat moved to Full access while in plan: the next approval returns there
  await call('claude:control', key, 'setPermissionMode', 'full-access');
  assert.deepEqual(q.modes, ['bypassPermissions']);
  assert.deepEqual((await ask()).updatedPermissions, [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }]);
  await call('claude:control', key, 'close');
});

test('background tasks survive Stop: sessions declare perTaskStopAffordance and stop tasks one by one', async () => {
  const o = claude.buildSessionOptions({ cwd: tmp, permission: 'default' }, {});
  assert.equal(o.perTaskStopAffordance, true);
  assert.equal(o.forwardSubagentText, true);
  closeThrows = false;
  const key = 'claude:tasks';
  const before = queries.length;
  await claude.send(key, opts('tasks', 'default'), msg('go'));
  await until('the reply', () => results(key) === 1);
  // a new process starts with no tasks
  assert.deepEqual(events.filter((e) => e.key === key && e.kind === 'tasks').at(0)?.tasks, []);
  await call('claude:control', key, 'stopTask', 'a1');
  assert.deepEqual(queries[before].stopped, ['a1']);
  await call('claude:control', key, 'close');
});

test('an effort change keeps ultracode the user turned on in the CLI, read with getSettings', async () => {
  closeThrows = false;
  const key = 'claude:ultra';
  const before = queries.length;
  await claude.send(key, opts('ultra', 'default'), msg('go'));
  await until('the reply', () => results(key) === 1);
  const q = queries[before];
  // "/effort ultracode on" typed in the chat: Sage never set it, the CLI has it
  q.applied.ultracode = true;
  await call('claude:control', key, 'applyFlagSettings', { effortLevel: 'low', fastMode: false });
  assert.deepEqual(q.flags.at(-1), { effortLevel: 'low', fastMode: false, ultracode: true });
  assert.equal(q.applied.ultracode, true);
  await until('the settings report', () => events.some((e) => e.key === key && e.kind === 'settings' && e.ultracode === true));
  const report = events.filter((e) => e.key === key && e.kind === 'settings').at(-1);
  assert.deepEqual({ probe: report.probe, available: report.available }, { probe: 'ok', available: true });
  // off stays off
  q.applied.ultracode = false;
  await call('claude:control', key, 'applyFlagSettings', { effortLevel: 'high', fastMode: false });
  assert.deepEqual(q.flags.at(-1), { effortLevel: 'high', fastMode: false });
  await call('claude:control', key, 'close');
});

test('temporary chats are unpersisted and stay on the account they started on', async () => {
  closeThrows = false;
  const key = 'claude:temp';
  const before = queries.length;
  await claude.send(key, { ...opts('temp', 'default'), resume: false, ephemeral: true }, msg('one'));
  await until('the reply', () => results(key) === 1);
  assert.equal(queries[before].options.persistSession, false);
  assert.equal(queries[before].options.enableFileCheckpointing, true);
  // an account move would need a resume, which an unpersisted session can't do
  await claude.send(key, { ...opts('temp', 'b1'), resume: false, ephemeral: true }, msg('two'));
  await until('the second reply', () => results(key) === 2);
  assert.equal(queries.length - before, 1);
  await call('claude:control', key, 'close');
});

test('fork from here ends with that turn', () => {
  const u = (uuid: string, content: any, extra: object = {}) => ({ type: 'user', uuid, message: { role: 'user', content }, ...extra });
  const a = (uuid: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text: 'ok' }] } });
  const msgs = [
    u('p1', 'first'),
    a('a1'),
    u('r1', [{ type: 'tool_result', tool_use_id: 't', content: 'x' }]),
    a('a2'),
    u('g1', 'Stop hook feedback', { isSynthetic: true }),
    a('a3'),
    u('p2', 'second'),
    a('a4'),
  ];
  assert.equal(claude.forkPoint(msgs, 'p1'), 'a3');
  assert.equal(claude.forkPoint(msgs, 'p2'), 'a4');
  assert.equal(claude.forkPoint(msgs, 'nope'), null);
});

test('edit rewinds files (dry run first) and the next process resumes just before the message', async () => {
  closeThrows = false;
  const cfg = path.join(tmp, 'claude-config');
  process.env.CLAUDE_CONFIG_DIR = cfg;
  fs.mkdirSync(path.join(cfg, 'projects', 'x'), { recursive: true });
  const lines = [
    { type: 'user', uuid: 'p1', parentUuid: null },
    { type: 'assistant', uuid: 'a1', parentUuid: 'p1' },
    { type: 'file-history-snapshot', messageId: 'p2', snapshot: {}, isSnapshotUpdate: false },
    { type: 'user', uuid: 'p2', parentUuid: 'a1' },
  ];
  fs.writeFileSync(path.join(cfg, 'projects', 'x', 'rw.jsonl'), lines.map((r) => JSON.stringify(r)).join('\n'));
  const key = 'claude:rw';
  const before = queries.length;
  const dry = await call('claude:rewind', key, opts('rw', 'default'), 'p2', true);
  assert.deepEqual(dry.filesChanged, ['/repo/f.txt']);
  // the first message has nothing before it: refused before any file changes
  assert.equal((await call('claude:rewind', key, opts('rw', 'default'), 'p1', false)).canRewind, false);
  assert.equal((await call('claude:rewind', key, opts('rw', 'default'), 'p2', false)).canRewind, true);
  assert.deepEqual(queries[before].rewinds, [
    { uuid: 'p2', dryRun: true },
    { uuid: 'p2', dryRun: false },
  ]);
  assert.deepEqual([queries[before].closed, events.filter((event) => event.kind === 'rewound').map((event) => event.key)], [true, [key]]);
  // until the edited message is sent again, reading the chat stops where it will go on from
  const chain = [{ uuid: 'p1' }, { uuid: 'a1' }, { uuid: 'p2' }, { uuid: 'a2' }];
  (globalThis as any).__fakeMessages = () => chain;
  assert.deepEqual(await claude.messages('rw'), [{ uuid: 'p1' }, { uuid: 'a1' }]);
  // a chat with no edit pending, or one whose resume point isn't in what was read, reads whole
  assert.equal(await claude.messages('other'), chain);
  (globalThis as any).__fakeMessages = () => [{ uuid: 'x' }];
  assert.deepEqual(await claude.messages('rw'), [{ uuid: 'x' }]);
  (globalThis as any).__fakeMessages = () => chain;
  await claude.send(key, opts('rw', 'default'), msg('edited'));
  await until('the reply', () => results(key) === 1);
  assert.equal(queries.at(-1)!.options.resumeSessionAt, 'a1');
  assert.equal(queries.at(-1)!.options.resume, 'rw');
  // sent again: the conversation is read whole (the new branch is the SDK's chain now)
  assert.equal(await claude.messages('rw'), chain);
  delete (globalThis as any).__fakeMessages;
  delete process.env.CLAUDE_CONFIG_DIR;
  await call('claude:control', key, 'close');
});

test('the command catalog merges supportedCommands, init and commands_changed; unchanged is null', () => {
  const a = claude.mergeCatalog(undefined, {
    commands: [{ name: 'code-review', description: 'Review', aliases: ['review'], argumentHint: '[low|high]' }],
  });
  assert.deepEqual(a.commands, [
    { name: 'code-review', description: 'Review', argumentHint: '[low|high]', aliases: ['review'], builtin: false },
  ]);
  const b = claude.mergeCatalog(a, {
    skills: ['deep-research', { name: 'pdf' }],
    plugins: [{ name: 'p', path: '/p' }],
    terminalSlash: ['doctor', 'color'],
    live: true,
  });
  assert.deepEqual(b.skills, ['deep-research', 'pdf']);
  assert.deepEqual(b.terminalSlash, ['doctor', 'color']);
  assert.equal(b.live, true);
  assert.equal(b.commands.length, 1);
  assert.equal(claude.mergeCatalog(b, { skills: ['deep-research', 'pdf'] }), null);
  // commands_changed replaces the list
  assert.deepEqual(
    claude.mergeCatalog(b, { commands: [{ name: 'init', description: 'x' }] }).commands.map((c: any) => c.name),
    ['init'],
  );
});

test('the MoPilot route lists the gateway models the CLI does not know, only those in the capability table', () => {
  const cli = [{ value: 'opus' }, { value: 'sonnet' }];
  const caps = {
    'claude-opus-5-5': { wires: ['anthropic'] },
    'deepseek-flash': { wires: ['anthropic'], efforts: ['low', 'high', 'max'] },
    'gpt-6-luna': { wires: ['responses', 'chat'] },
  };
  const out = claude.withGatewayModels(cli, caps);
  assert.deepEqual(
    out.map((m: any) => m.value),
    ['opus', 'sonnet', 'deepseek-flash'],
  );
  assert.deepEqual(out[2].supportedEffortLevels, ['low', 'high', 'max']);
  assert.equal(out[2].supportsFastMode, false);
  // no table, or no entry: nothing is added
  assert.equal(claude.withGatewayModels(cli, null), cli);
  assert.equal(claude.withGatewayModels(cli, { 'gpt-6-luna': caps['gpt-6-luna'] }), cli);
});

test('sessions show hooks, summarize sub-agents and answer MCP elicitations through the app', async () => {
  const o = claude.buildSessionOptions({ cwd: tmp, permission: 'default' }, { onElicitation: () => null });
  assert.equal(o.includeHookEvents, undefined);
  assert.equal(o.agentProgressSummaries, true);
  closeThrows = false;
  const key = 'claude:elicit';
  const before = queries.length;
  await claude.send(key, opts('elicit', 'default'), msg('go'));
  await until('the reply', () => results(key) === 1);
  const answer = queries[before].options.onElicitation(
    { serverName: 'linear', message: 'Sign in', mode: 'url', url: 'https://example.test/auth' },
    {},
  );
  await until('the card', () => events.some((e) => e.key === key && e.kind === 'elicitation'));
  const card = events.find((e) => e.key === key && e.kind === 'elicitation');
  assert.equal(card.url, 'https://example.test/auth');
  await call('claude:permission', card.requestId, { action: 'accept', content: null });
  assert.deepEqual(await answer, { action: 'accept' });
  await call('claude:control', key, 'close');
});

// D-34 / D-74: billing switches restart only idle processes; they never close everything.
test('a billing switch restarts idle chats, spares side chats, and a chat started afterwards stays', async () => {
  closeThrows = false;
  const idle = 'claude:bill-idle';
  const side = 'claude:bill-side';
  await claude.send(idle, opts('bill-idle', 'default'), msg('one'));
  await claude.send(side, { ...opts('bill-side', 'default'), ephemeral: true }, msg('one'));
  await until('both replies', () => results(idle) === 1 && results(side) === 1);
  const before = queries.length;
  const [idleQ, sideQ] = queries.slice(before - 2);
  await call('claude:setApiKey', 'sk-test-0001');
  await until('the idle chat closed', () => idleQ.closed);
  assert.equal(sideQ.closed, false);
  // its next turn starts a fresh process on the new credentials
  await claude.send(idle, opts('bill-idle', 'default'), msg('two'));
  await until('the reply', () => results(idle) === 2);
  assert.equal(queries.length - before, 1);
  // a chat already on the new credentials is left alone
  await call('claude:setApiKey', 'sk-test-0001');
  await claude.send(idle, opts('bill-idle', 'default'), msg('three'));
  await until('the reply', () => results(idle) === 3);
  assert.equal(queries.length - before, 1);
  await call('claude:control', idle, 'close');
  await call('claude:control', side, 'close');
});

test('signing out of MoPilot goes back to the subscription, never to a saved key, and restarts idle chats on it', async () => {
  closeThrows = false;
  let gw: string | null = 'mpk_test';
  claude.setGatewayKeyProvider(() => gw);
  await call('claude:setApiKey', 'sk-test-0002');
  await call('claude:setAuthMode', 'mopilot');
  assert.equal(claude.authMode(), 'mopilot');
  const key = 'claude:bill-mopilot';
  await claude.send(key, opts('bill-mopilot', 'default'), msg('one'));
  await until('the reply', () => results(key) === 1);
  const q = queries.at(-1)!;
  gw = null;
  claude.mopilotChanged();
  assert.equal(claude.authMode(), 'subscription');
  await until('the chat on the revoked key closed', () => q.closed);
  await call('claude:clearApiKey');
  assert.equal(claude.authMode(), 'subscription');
  await call('claude:control', key, 'close');
});

test('a CLI killed outside MoPilot leaves no command running: its pid is watched and what it started is ended with its session (#1486)', async () => {
  const { spawn } = await import('node:child_process');
  // the SDK reports the CLI's pid through this hook; the guard keeps it from going away unnoticed in an upgrade
  const sdkSource = fs.readFileSync(path.join(import.meta.dirname, '../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'), 'utf8');
  assert.match(sdkSource, /this\.options\.onProcessSpawned\(/, 'the SDK still calls options.onProcessSpawned(pid)');
  assert.equal(claude.buildSessionOptions({ cwd: tmp }, {}).onProcessSpawned, undefined);
  const hook = () => {};
  assert.equal(claude.buildSessionOptions({ cwd: tmp }, { onSpawned: hook }).onProcessSpawned, hook);
  closeThrows = false;
  const key = 'claude:orphans';
  await claude.send(key, opts('orphans', 'default'), msg('one'));
  await until('the reply', () => results(key) === 1);
  const q = queries.at(-1)!;
  assert.equal(typeof q.options.onProcessSpawned, 'function');
  // a stand-in CLI whose command runs in a group of its own, as Claude Code's do
  const cli = spawn(
    process.execPath,
    [
      '-e',
      "const c = require('child_process').spawn('sleep', ['30'], { stdio: 'ignore', detached: true }); console.log(c.pid); setInterval(() => {}, 1000)",
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const command = await new Promise<number>((r) => cli.stdout.once('data', (d) => r(Number(String(d).trim()))));
  q.options.onProcessSpawned(cli.pid);
  // a second report of a pid (the SDK starting the CLI again) replaces the first recording
  q.options.onProcessSpawned(cli.pid);
  const { watcher } = createRequire(import.meta.url)('../electron/platform/processTree.cjs');
  await watcher.tick();
  process.kill(cli.pid!, 'SIGKILL');
  await new Promise((r) => cli.once('exit', r));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(alive(command), true, 'its command outlived it');
  await call('claude:control', key, 'close');
  await until('the command to be ended', () => !alive(command));
});
