// Native harness contracts exercise production detection, admission and windowless chats through fake process boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, fakeSpawn, INIT, dir, until } from './support/acp-host/fixture.ts';
import { ACP_CATALOG } from '../shared/harnessCatalog.mjs';

export const GUARDS = ['shared/harnesses/', 'shared/harnessCatalog.mjs', 'electron/harness/', 'tests/support/acp-mimics/'];

const require = createRequire(import.meta.url);
const Q = require('../electron/harness/quirks/index.cjs');
const { resolveBasic } = require('../electron/harness/detect.cjs');
const { probe } = require('../electron/harness/admission.cjs');
const profiles: [string, string[]][] = [
  ['auggie', ['--acp']],
  ['autohand', ['--acp']],
  ['cline', ['--acp']],
  ['codebuddy', ['--acp']],
  ['qoder', ['--acp']],
  ['qoder-cn', ['--acp']],
  ['kilo', ['acp']],
  ['mimo', ['acp']],
  ['mistral-vibe', []],
  ['omp', ['acp']],
  ['command-code', ['acp']],
  ['devin', ['acp']],
  ['droid', ['exec', '--output-format', 'acp-daemon']],
  ['hermes', ['acp']],
  ['kiro', ['acp']],
  ['trae', ['acp', 'serve']],
  ['grok', ['agent', 'stdio']],
  ['muse', ['acp']],
  ['prime-agent', ['--mode', 'acp']],
];
const nativeInitialize = (id: string) =>
  INIT(
    { ...require(`./support/acp-mimics/${id}.mjs`).default, sessionCapabilities: { close: {} }, promptCapabilities: { image: true } },
    {
      _meta: { modelState: { currentModelId: 'default', availableModels: [{ modelId: 'native/model', name: 'Native model' }] } },
    },
  );

for (const [id, args] of profiles) {
  const initialize = () => nativeInitialize(id);
  test(`${id}: detects its native executable and launches the vendor's ACP argv`, async () => {
    const d = ACP_CATALOG[id];
    for (const name of d.bins)
      assert.equal(
        resolveBasic(id, { env: {}, which: (bin: string) => (bin === name ? `/tools/${name}` : null), known: [] }),
        `/tools/${name}`,
      );
    assert.equal(resolveBasic(id, { env: {}, which: () => null, known: [] }), null);
    const t = setup({ quirks: Q.quirks, resolveBin: () => `/tools/${d.bins[0]}`, handlers: { initialize } });
    try {
      await t.host.ensure(`acp:${id}:native`, { cwd: dir, chatId: 'stable-chat' });
      assert.deepEqual(t.sp.calls[0].args, args);
      assert.equal(t.sp.calls[0].command, `/tools/${d.bins[0]}`);
      assert.deepEqual(t.sp.calls[0].options.env, { BASE: '1', ...d.acp.env });
      assert.equal(Q.anchorOf(Q.quirks(id), 'unknown'), 'ask');
      assert.equal(Q.isolates(id), false, 'coding integration does not imply MoMo confinement');
    } finally {
      t.host.closeAll();
    }
  });

  test(`${id}: admission preserves sign-in, unsupported protocol, tool failures and native recovery boundaries`, async () => {
    for (const outcome of ['admitted', 'signin', 'no-tools', 'bad-protocol', 'no-resume']) {
      const sp = fakeSpawn({
        initialize: () => (outcome === 'bad-protocol' ? { protocolVersion: 2 } : outcome === 'no-resume' ? INIT() : initialize()),
        'session/new': () => {
          if (outcome === 'signin') throw Object.assign(new Error('Authentication required'), { code: -32000 });
          return { sessionId: `${id}-native` };
        },
      });
      let ended = 0;
      const result = await probe(id, {
        quirks: Q.quirks,
        resolveBin: () => `/tools/${id}`,
        env: () => ({}),
        dataDir: dir,
        spawnFn: sp.spawnFn,
        tools: {
          prepare: async () => ({ mcpServers: [{ name: 'sage_0123456789ab', command: '/tools/sage-mcp', args: [], env: [] }] }),
          admission: async () => outcome !== 'no-tools',
          end: () => {
            ended++;
          },
        },
      });
      assert.equal(
        result.state,
        outcome === 'admitted' ? 'admitted' : outcome === 'signin' ? 'signin' : 'unsupported',
        `${id}: ${outcome}`,
      );
      assert.equal(ended, 1);
      assert.equal(sp.procs[0].stdin.ended, true);
      if (outcome === 'no-tools') assert.match(result.reason, /computer and browser control/);
      if (outcome === 'no-resume') assert.match(result.reason, /cannot reopen native sessions/);
    }
  });

  test(`${id}: two same-folder chats keep independent tools, permission cards and native identity without a window`, async () => {
    const permissionAnswers: any[] = [];
    const t = setup({
      quirks: Q.quirks,
      handlers: {
        initialize,
        'session/prompt': async (params: any, proc: any) => {
          proc.notify('session/update', {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native reply' } },
          });
          permissionAnswers.push(
            await proc.request('session/request_permission', {
              sessionId: params.sessionId,
              toolCall: { toolCallId: 'shell-call', title: 'Shell', kind: 'execute' },
              options: [
                { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
                { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
              ],
            }),
          );
          return { stopReason: 'end_turn' };
        },
      },
    });
    t.host.on('event', (event: any) => {
      if (event.kind === 'permission') t.host.permission(event.requestId, 'deny');
    });
    try {
      const a = `acp:${id}:a`,
        b = `acp:${id}:b`;
      const [first, second] = await Promise.all([
        t.host.ensure(a, { cwd: dir, chatId: 'chat-a' }),
        t.host.ensure(b, { cwd: dir, chatId: 'chat-b' }),
      ]);
      assert.notEqual(first.agent, second.agent);
      assert.deepEqual(t.prepared.map((p: any) => p.chatId).sort(), ['chat-a', 'chat-b']);
      const sent = await t.host.send(
        a,
        { cwd: dir, blocks: [{ type: 'text', text: 'hello' }], display: [{ type: 'text', text: 'hello' }] },
        { human: true },
      );
      await until(() => t.events.some((e: any) => e.kind === 'turnEnd' && e.turnId === sent.turnId));
      assert.equal(permissionAnswers[0].result.outcome.optionId, 'deny');
      assert.ok(t.events.some((e: any) => e.kind === 'update' && e.update.content?.text === 'native reply'));
      t.items.append(`acp:${id}:reopened`, { t: 'session', sessionId: `${id}-saved`, cwd: dir });
      await t.host.ensure(`acp:${id}:reopened`);
      assert.equal(t.sp.procs[2].received.find((m: any) => m.method === 'session/load').params.sessionId, `${id}-saved`);
    } finally {
      t.host.closeAll();
    }
  });
}

test('new native processes enforce compatibility again rather than trusting an old admission cache', async () => {
  for (const initialize of [() => INIT(), () => INIT({ loadSession: true }, { agentInfo: { version: '0.10.0' } })]) {
    const t = setup({ quirks: Q.quirks, handlers: { initialize } });
    try {
      await assert.rejects(
        t.host.ensure('acp:prime-agent:unsupported', { cwd: dir }),
        /cannot reopen native sessions|changes shared settings/,
      );
      assert.equal(t.sp.procs[0].stdin.ended, true);
      assert.equal(
        t.sp.procs[0].received.some((m: any) => m.method === 'session/new'),
        false,
      );
    } finally {
      t.host.closeAll();
    }
  }
});
