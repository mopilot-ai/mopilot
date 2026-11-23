// The #1320 spike: Claude Code and Codex behind their upstream ACP adapters (quirks/claude-acp.cjs, quirks/codex-acp.cjs),
// listed only behind their developer flags, which ship off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Q = require('../electron/harness/quirks/index.cjs');
const { DEFAULTS } = require('../electron/platform/flags.cjs');
const claude = require('../electron/harness/quirks/claude-acp.cjs');
const codex = require('../electron/harness/quirks/codex-acp.cjs');

test('the spike harnesses ship off and are listed only when an unpackaged build’s MOPILOT_FLAGS turns one on', () => {
  const spike = (o?: object) => Q.ids(o).filter((id: string) => Q.SPIKE_IDS.includes(id));
  const on = { MOPILOT_FLAGS: 'harness.acp.claude-acp.enabled=1' };
  for (const id of Q.SPIKE_IDS) assert.equal(DEFAULTS[`harness.acp.${id}.enabled`], false, id);
  // a caller that doesn't say it runs unpackaged lists none, whatever the environment says
  assert.deepEqual(spike(), []);
  assert.deepEqual(spike({ env: on }), []);
  assert.deepEqual(spike({ packaged: true, env: on }), []);
  assert.deepEqual(spike({ packaged: false, env: {} }), []);
  assert.deepEqual(spike({ packaged: false, env: { MOPILOT_FLAGS: 'harness.acp.claude-acp.enabled=0' } }), []);
  assert.deepEqual(spike({ packaged: false, env: on }), ['claude-acp']);
  // the basic harnesses are listed either way and keep their defaults
  assert.ok(Q.ids({ packaged: false, env: on }).includes('opencode'));
  assert.equal(DEFAULTS['harness.acp.opencode.enabled'], true);
  assert.equal(DEFAULTS['harness.acp.trae.enabled'], false);
});

test('each spike quirks file loads and passes the quirks contract', () => {
  for (const id of Q.SPIKE_IDS) {
    const q = Q.quirks(id);
    assert.equal(q.id, id);
    assert.deepEqual(Q.validate(q), [], id);
    // stdio MCP servers are offered: MoPilot's tools and plugins' local servers
    assert.notEqual(q.mcpStdio, false, id);
    // their sessions show in MoPilot's own Claude Code and Codex lists: no hidden title session (#2150)
    assert.equal(q.titleSessions, false, id);
  }
  // Claude Code's plan is a mode; Codex's is a config option over its sandbox modes
  assert.equal(Q.anchorOf(Q.quirks('claude-acp'), 'plan'), 'readOnly');
  assert.equal(Q.anchorOf(Q.quirks('codex-acp'), 'read-only'), 'readOnly');
  assert.equal(Q.anchorOf(Q.quirks('codex-acp'), 'plan'), 'readOnly');
  assert.equal(Q.anchorOf(Q.quirks('claude-acp'), 'bypassPermissions'), 'full');
  assert.equal(claude.resumeCommand('s1'), 'claude --resume s1');
  assert.equal(codex.resumeCommand('t1'), 'codex resume t1');
  assert.deepEqual(Q.describe('codex-acp').plan, { configOption: 'collaboration_mode', value: 'plan' });
  // main's permissions capability reads the agent's own modes through describe (#1875): opencode's build
  assert.deepEqual(Q.describe('opencode').agentModes, ['build']);
});

test('claude-acp runs the environment’s claude, else the one on PATH, else the SDK’s own', () => {
  const none = () => null;
  assert.equal(claude.claudePath({ CLAUDE_CODE_EXECUTABLE: '/opt/claude' }, none), '/opt/claude');
  const asked: unknown[] = [];
  const onPath = (name: string, p: string) => (asked.push([name, p]), '/bin/claude');
  assert.equal(claude.claudePath({ PATH: '/bin' }, onPath), '/bin/claude');
  assert.equal(claude.claudePath({}, onPath), '/bin/claude');
  assert.deepEqual(asked, [
    ['claude', '/bin'],
    ['claude', ''],
  ]);
  assert.equal(claude.claudePath({ PATH: '/bin' }, none), null);
  assert.deepEqual(claude.launch({ env: { CLAUDE_CODE_EXECUTABLE: '/opt/claude' } }), {
    args: [],
    env: { CLAUDE_CODE_EXECUTABLE: '/opt/claude' },
  });
  assert.deepEqual(claude.launch({ env: { PATH: '' } }), { args: [], env: {} });
  // MoPilot's own auth and nested-session variables are left out, as the first-class adapter's cleanEnv does
  assert.deepEqual(claude.launch({ env: { CLAUDE_CODE_EXECUTABLE: '/opt/claude', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', HOME: '/h' } }), {
    args: [],
    env: { ANTHROPIC_API_KEY: undefined, CLAUDECODE: undefined, CLAUDE_CODE_EXECUTABLE: '/opt/claude' },
  });
});

test('codex-acp runs the environment’s codex, else PATH’s, else an app’s copy, else its own', () => {
  const none = () => null;
  const nothing = () => false;
  assert.equal(codex.codexPath({ CODEX_PATH: '/opt/codex' }, none, nothing), '/opt/codex');
  assert.equal(
    codex.codexPath({ PATH: '/bin' }, (n: string, p: string) => (n === 'codex' && p === '/bin' ? '/bin/codex' : null), nothing),
    '/bin/codex',
  );
  const app = '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex';
  assert.equal(
    codex.codexPath({}, none, (p: string) => p === app),
    app,
  );
  assert.equal(codex.codexPath({}, none, nothing), null);
  assert.deepEqual(codex.launch({ env: { CODEX_PATH: '/opt/codex' } }), { args: [], env: { CODEX_PATH: '/opt/codex' } });
  // none found: the adapter runs the @openai/codex it bundles
  assert.deepEqual(
    codex.launch({ env: {} }, () => null),
    { args: [], env: {} },
  );
});
