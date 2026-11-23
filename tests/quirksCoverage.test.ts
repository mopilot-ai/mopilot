// electron/harness/quirks: loading and validating quirks files, finding a harness binary, what the
// window is told, Cursor's extension methods, and dsh's patch and privacy gate (with a fake dsh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Q = require('../electron/harness/quirks/index.cjs');
const cursor = require('../electron/harness/quirks/cursor.cjs');
const dsh = require('../electron/harness/quirks/dsh.cjs');

test('load: a missing quirks file is null; any other load error is thrown', () => {
  const missing = Object.assign(new Error("Cannot find module './kimi.cjs'"), { code: 'MODULE_NOT_FOUND' });
  assert.equal(
    Q.load('kimi', () => {
      throw missing;
    }),
    null,
  );
  const inner = Object.assign(new Error("Cannot find module 'left-pad'"), { code: 'MODULE_NOT_FOUND' });
  assert.throws(
    () =>
      Q.load('kimi', () => {
        throw inner;
      }),
    /left-pad/,
  );
  assert.throws(
    () =>
      Q.load('kimi', () => {
        throw new SyntaxError('bad');
      }),
    SyntaxError,
  );
  assert.throws(() =>
    Q.load('kimi', () => {
      throw null;
    }),
  );
  assert.equal(Q.load('cursor').label, 'Cursor');
});

test('quirks: unknown ids and missing files are null; defaults are filled in', () => {
  assert.equal(Q.quirks('nope'), null);
  assert.equal(
    Q.quirks('kimi', () => null),
    null,
  );
  assert.deepEqual(
    Q.quirks('kimi', () => ({ label: 'K' })),
    { id: 'kimi', env: {}, label: 'K' },
  );
  assert.ok(Q.ids().includes('dsh'));
});

test('validate names each problem', () => {
  const good = { label: 'X', bins: ['x'], args: [], privacyDefaults: [], admission: { handshakeTimeoutMs: 1 } };
  assert.deepEqual(Q.validate(good), []);
  assert.deepEqual(Q.validate(null), ['missing']);
  assert.deepEqual(Q.validate('x'), ['missing']);
  assert.deepEqual(Q.validate({ label: '', bins: [], admission: null }), [
    'label',
    'bins',
    'args or launch',
    'privacyDefaults',
    'admission',
  ]);
  assert.deepEqual(Q.validate({ label: 5, bins: 'x', launch: () => {}, privacyDefaults: [], admission: 'a' }), [
    'label',
    'bins',
    'admission',
  ]);
  assert.deepEqual(Q.validate({ ...good, admission: { handshakeTimeoutMs: 0 } }), ['admission']);
  assert.deepEqual(Q.validate({ ...good, admission: { handshakeTimeoutMs: 1, privacyGate: 'no' } }), ['admission.privacyGate']);
  assert.deepEqual(Q.validate({ ...good, admission: { handshakeTimeoutMs: 1, privacyGate: () => {} } }), []);
  assert.deepEqual(Q.validate({ ...good, anchors: 'x' }), ['anchors']);
  assert.deepEqual(Q.validate({ ...good, anchors: { a: 'sometimes' } }), ['anchors']);
  assert.deepEqual(Q.validate({ ...good, anchors: { a: 'full' } }), []);
  assert.deepEqual(Q.validate({ ...good, permissionModes: 'x' }), ['permissionModes']);
  assert.deepEqual(Q.validate({ ...good, permissionModes: { a: 'full' } }), ['permissionModes']);
  assert.deepEqual(Q.validate({ ...good, permissionModes: { a: 'full-access', b: 'read-only' } }), []);
  // the agent's own modes (#1875): a list of ids, none of them also a permission row
  for (const agentModes of ['a', [1], ['a']])
    assert.deepEqual(Q.validate({ ...good, permissionModes: { a: 'default' }, agentModes }), ['agentModes']);
  assert.deepEqual(Q.validate({ ...good, agentModes: ['a'] }), []);
  assert.deepEqual(Q.validate({ ...good, plan: {} }), ['plan']);
  assert.deepEqual(Q.validate({ ...good, plan: 'plan' }), ['plan']);
  // plan only reads: its mode or value must be anchored readOnly
  assert.deepEqual(Q.validate({ ...good, plan: { configOption: 'mode', value: 'plan' } }), ['plan anchor']);
  assert.deepEqual(Q.validate({ ...good, plan: { configOption: 'mode', value: 'plan' }, anchors: { plan: 'readOnly' } }), []);
  assert.deepEqual(Q.validate({ ...good, plan: { mode: 'plan' }, anchors: { plan: 'readOnly' } }), []);
  assert.deepEqual(Q.validate({ ...good, modalities: 3 }), ['modalities']);
  assert.deepEqual(Q.validate({ ...good, modalities: { m: 'text' } }), ['modalities']);
  assert.deepEqual(Q.validate({ ...good, modalities: { m: ['text'] } }), []);
  assert.deepEqual(Q.validate({ ...good, resumeCommand: 'x' }), ['resumeCommand']);
  assert.deepEqual(Q.validate({ ...good, resumeCommand: () => '' }), []);
  assert.deepEqual(Q.validate({ ...good, versions: 'x' }), ['versions']);
  assert.deepEqual(Q.validate({ ...good, versions: {} }), []);
  for (const id of Q.ids()) assert.deepEqual(Q.validate(Q.quirks(id)), [], id);
});

test('anchorOf: listed anchors, else ask', () => {
  assert.equal(Q.anchorOf(cursor, 'plan'), 'readOnly');
  assert.equal(Q.anchorOf(cursor, 'other'), 'ask');
  assert.equal(Q.anchorOf(null, 'plan'), 'ask');
});

test('findBin: SAGE_ACP_BINS wins (bad JSON or no entry is null); else the first bin on PATH', () => {
  const which = (b: string) => (b === 'agent' ? '/bin/agent' : null);
  assert.equal(Q.findBin('cursor', which, { SAGE_ACP_BINS: '{"cursor":"/x/agent"}' }), '/x/agent');
  assert.equal(Q.findBin('kimi', which, { SAGE_ACP_BINS: '{"cursor":"/x/agent"}' }), null);
  assert.equal(Q.findBin('cursor', which, { SAGE_ACP_BINS: '{"cursor":""}' }), null);
  assert.equal(Q.findBin('cursor', which, { SAGE_ACP_BINS: '{bad' }), null);
  assert.equal(Q.findBin('cursor', which, {}), '/bin/agent');
  assert.equal(
    Q.findBin('cursor', () => null, {}),
    null,
  );
  assert.equal(Q.findBin('nope', which, {}), null);
  assert.equal(typeof Q.findBin('nope', which), 'object');
});

test('describe: what the window needs, with defaults; null for unknown harnesses', () => {
  assert.equal(Q.describe('nope'), null);
  assert.deepEqual(Q.describe('cursor'), {
    id: 'cursor',
    label: 'Cursor',
    privacyDefaults: [],
    anchors: cursor.anchors,
    plan: { mode: 'plan' },
    agentModes: ['agent', 'ask', 'plan'],
    modalities: null,
    hasResumeCommand: false,
    instructionsFiles: ['AGENTS.md'],
  });
  assert.deepEqual(
    Q.describe('kimi', () => ({ label: 'K', resumeCommand: () => '' })),
    {
      id: 'kimi',
      label: 'K',
      privacyDefaults: [],
      anchors: {},
      plan: null,
      agentModes: [],
      modalities: null,
      hasResumeCommand: true,
      instructionsFiles: [],
    },
  );
});

test('Cursor: update_todos becomes the plan; create_plan is shown and accepted', () => {
  const todos = cursor.extensions['cursor/update_todos']({
    todos: [{ content: 'a', status: 'done' }, { title: 'b', status: 'weird' }, { status: 'in_progress' }],
  });
  assert.deepEqual(todos.update.entries, [
    { content: 'a', status: 'completed', priority: 'medium' },
    { content: 'b', status: 'pending', priority: 'medium' },
    { content: '', status: 'in_progress', priority: 'medium' },
  ]);
  assert.deepEqual(cursor.extensions['cursor/update_todos'](null).update.entries, []);
  const plan = cursor.extensions['cursor/create_plan']({ plan: 'Do it' });
  assert.deepEqual(plan, {
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Do it' } },
    result: { accepted: true },
  });
  assert.equal(cursor.extensions['cursor/create_plan']({ content: 'C' }).update.content.text, 'C');
  assert.equal(cursor.extensions['cursor/create_plan'](undefined).update.content.text, '');
});

test('dsh launch writes the patch once (rewriting a changed one) and turns telemetry off', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  assert.throws(() => dsh.launch({}), /No folder/);
  const r = dsh.launch({ dataDir: d });
  const file = path.join(d, 'dsh', 'sage.patch.yml');
  assert.deepEqual(r, { args: ['--profile', 'acp', '--patch', file], env: { DSH_TELEMETRY_DISABLED: '1' } });
  assert.equal(fs.readFileSync(file, 'utf8'), dsh._test.PATCH);
  const mtime = fs.statSync(file).mtimeMs;
  dsh._test.writePatch(d);
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'unchanged file left alone');
  fs.writeFileSync(file, 'old');
  dsh._test.writePatch(d);
  assert.equal(fs.readFileSync(file, 'utf8'), dsh._test.PATCH);
});

test('dsh readDump: the patch itself (YAML) shows both rows off', () => {
  assert.deepEqual(dsh._test.readDump(dsh._test.PATCH), { sessionLog: 'off', telemetry: 'off' });
});

test('dsh readDump: YAML blocks, disabled rows, quoted ids and comments', () => {
  const yaml = [
    'rows:',
    "  - id: 'session-log-deepseek' # upload",
    '    config:',
    '',
    '      enabled: true',
    '  - id: other',
    '  - id: session-telemetry-otel',
    '    disabled: true',
    'next: 1',
  ].join('\n');
  assert.deepEqual(dsh._test.readDump(yaml), { sessionLog: 'on', telemetry: 'off' });
  assert.deepEqual(
    dsh._test.readDump('- id: session-log-deepseek\n  disabled: true\n- id: session-telemetry-otel\n  config:\n    mode: "OTLP"'),
    { sessionLog: 'off', telemetry: 'on' },
  );
  assert.deepEqual(dsh._test.readDump('nothing here'), { sessionLog: 'unknown', telemetry: 'absent' });
  assert.deepEqual(dsh._test.readDump('- id: session-telemetry-otel\n  config: {}'), { sessionLog: 'unknown', telemetry: 'on' });
});

test('dsh readDump: a JSON tree, nested anywhere', () => {
  const tree = {
    profiles: [{ rows: [{ id: 'session-log-deepseek', config: { enabled: false } }, null, 'x'] }],
    extra: { id: 'session-telemetry-otel', config: { mode: 'disabled' } },
  };
  assert.deepEqual(dsh._test.readDump(JSON.stringify(tree)), { sessionLog: 'off', telemetry: 'off' });
  const on = [
    { id: 'session-log-deepseek', config: {} },
    { id: 'session-telemetry-otel', disabled: true },
  ];
  assert.deepEqual(dsh._test.readDump(JSON.stringify(on)), { sessionLog: 'on', telemetry: 'off' });
  const tel = [{ id: 'session-log-deepseek', disabled: true }, { id: 'session-telemetry-otel' }];
  assert.deepEqual(dsh._test.readDump(JSON.stringify(tel)), { sessionLog: 'off', telemetry: 'on' });
});

test('dsh privacy gate: --dump-config with the launch arguments must show both rows off', async (t) => {
  let out: { err: any; stdout: any } = { err: null, stdout: '' };
  const calls: any[] = [];
  t.mock.method(childProcess, 'execFile', (bin: string, args: string[], opts: any, cb: any) => {
    calls.push([bin, args, opts.env, opts.timeout]);
    setImmediate(() => cb(out.err, out.stdout));
  });
  const gate = dsh.admission.privacyGate;
  const ctx = { bin: '/bin/dsh', args: ['--profile', 'acp'], env: { A: '1' } };
  out = { err: null, stdout: dsh._test.PATCH };
  assert.deepEqual(await gate(ctx), { ok: true, reason: null });
  assert.deepEqual(calls[0], ['/bin/dsh', ['--profile', 'acp', '--dump-config'], { A: '1' }, 20_000]);
  out = { err: new Error('unknown flag\nmore'), stdout: '' };
  assert.deepEqual(await gate(ctx), {
    ok: false,
    reason: "This dsh version can't turn off session log upload (--dump-config failed: unknown flag)",
  });
  out = { err: { message: undefined, toString: () => 'odd' }, stdout: null };
  assert.match((await gate(ctx)).reason, /--dump-config failed: odd/);
  out = { err: new Error('exit 1'), stdout: '- id: session-log-deepseek\n  config:\n    enabled: true' };
  assert.deepEqual(await gate(ctx), { ok: false, reason: "This dsh version can't turn off session log upload" });
  out = { err: null, stdout: '- id: session-log-deepseek\n  disabled: true\n- id: session-telemetry-otel\n  config:\n    mode: OTLP' };
  assert.deepEqual(await gate(ctx), { ok: false, reason: "This dsh version can't turn off its telemetry" });
  out = { err: null, stdout: undefined };
  assert.equal((await gate(ctx)).ok, false);
});

test('opencode: the two agents MoPilot adds come only through its process config, each mapped to a permission row', () => {
  const q = Q.quirks('opencode');
  const config = JSON.parse(q.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.share, 'disabled');
  assert.deepEqual(Object.keys(config.agent), ['mopilot-ask', 'mopilot-full']);
  for (const a of Object.values(config.agent) as any[]) assert.equal(a.mode, 'primary');
  assert.deepEqual(config.agent['mopilot-ask'].permission, { edit: 'ask', bash: 'ask', webfetch: 'ask' });
  assert.ok(Object.values(config.agent['mopilot-full'].permission).every((p) => p === 'allow'));
  // every mode it maps is a mode opencode lists (its own build and plan, and the two added here)
  for (const id of Object.keys(q.permissionModes)) assert.ok(['build', 'plan', ...Object.keys(config.agent)].includes(id), id);
  assert.equal(q.anchors['mopilot-full'], 'full');
  assert.equal(q.anchors['mopilot-ask'], 'ask');
  // build follows the user's own opencode permissions, so it keeps its name
  assert.equal(q.permissionModes.build, undefined);
});
