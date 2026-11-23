// Native ACP protocol hooks normalize vendor envelopes and tool evidence through the production host and translator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, INIT, dir, until, fakeSpawn } from './support/acp-host/fixture.ts';
import { toolItem as toolItemTyped } from '../shared/acpItems/toolItems.mjs';

const toolItem = (tc: unknown, cwd: string): any => toolItemTyped(tc, cwd);
const require = createRequire(import.meta.url);
const Q = require('../electron/harness/quirks/index.cjs');
const grok = require('../electron/harness/quirks/grok.cjs');
const omp = require('../electron/harness/quirks/omp.cjs');
const { nativeCompatibility } = require('../electron/harness/acp/nativeCompatibility.cjs');
const { initialModels } = require('../electron/harness/acp/initialModels.cjs');
const { setupFailure } = require('../electron/harness/acp/signin.cjs');

test('OMP recognizes its typed provider-configuration errors without trusting arbitrary error details', () => {
  const q = Q.quirks('omp');
  for (const details of ['No model selected.\n\nUse /login to configure a provider', 'No API key found for vendor']) {
    const error = { code: -32603, said: 'Internal error', data: { details } };
    assert.equal(setupFailure(q, error).setup, q.setup.reason);
  }
  for (const error of [
    null,
    {},
    { code: -32603 },
    { code: -32603, data: { details: [] } },
    { code: -1, data: { details: 'No API key found for vendor' } },
    { code: -32603, data: { details: 'Tool output: No API key found for vendor' } },
    { code: -32603, data: { details: 'No model selected.' } },
  ])
    assert.equal(setupFailure(q, error), error);
  assert.deepEqual(Q.validate({ ...q, setup: { ...q.setup, matchesError: 'invalid' } }), ['setup']);
  const unknown = { code: -32603, data: { details: 'No API key found for vendor' } };
  assert.equal(setupFailure(undefined, unknown), unknown);
});

test('OMP provider setup failures cross the native RPC boundary into admission and turn status', async () => {
  const fail = () => {
    throw Object.assign(new Error('Internal error'), {
      code: -32603,
      data: { details: 'No API key found for vendor' },
    });
  };
  const { probe } = require('../electron/harness/admission.cjs');
  const result = await probe('omp', {
    quirks: Q.quirks,
    resolveBin: () => '/tools/omp',
    env: () => ({}),
    dataDir: dir,
    spawnFn: fakeSpawn({ initialize: () => INIT({ loadSession: true }), 'session/new': fail }).spawnFn,
    tools: { prepare: async () => ({ mcpServers: [] }), admission: async () => true, end: () => {} },
  });
  assert.equal(result.state, 'signin');
  assert.equal(result.reason, omp.setup.reason);
  const t = setup({
    quirks: Q.quirks,
    handlers: {
      initialize: () => INIT({ loadSession: true }),
      'session/prompt': fail,
    },
  });
  const out: any[] = [];
  t.host.signedOutFn = (...args: any[]) => out.push(args);
  try {
    await t.host.send('acp:omp:a', { cwd: dir, blocks: [] });
    await until(() => t.events.some((e: any) => e.kind === 'turnEnd'));
    assert.deepEqual(out, [['omp', 'session/prompt', omp.setup.reason]]);
    assert.match(t.events.find((e: any) => e.kind === 'turnEnd').error, /Configure an oh-my-pi provider/);
  } finally {
    t.host.closeAll();
  }
});

test('native compatibility rejects only required unsupported capabilities and known incompatible versions', () => {
  assert.equal(nativeCompatibility({}, {}, undefined), null);
  assert.equal(nativeCompatibility({ admission: {} }, {}, {}), null);
  const q = Q.quirks('prime-agent');
  assert.match(nativeCompatibility(q, { loadSession: true }, { agentInfo: { version: '0.10.0' } }), /changes shared settings/);
  assert.equal(nativeCompatibility(q, { resume: true }, {}), null);
  assert.equal(nativeCompatibility(q, { loadSession: true }, {}), null);
});

test('Grok discovers advertised or extension-listed models without claiming a session default or inventing effort', async () => {
  const models = [{ modelId: 'grok/native', name: 'Native' }];
  assert.deepEqual(await grok.readModels({ init: { _meta: { modelState: { currentModelId: 'other', availableModels: models } } } }), {
    availableModels: models,
  });
  const requests: any[] = [];
  const agent = {
    request: async (...args: any[]) => (requests.push(args), { result: { currentModelId: 'other', availableModels: models } }),
  };
  assert.deepEqual(await grok.readModels(agent), { availableModels: models });
  assert.deepEqual(requests, [['x.ai/models/list', {}, { timeoutMs: 10_000 }]]);
  assert.deepEqual(await grok.readModels({ request: async () => ({ result: { availableModels: [{ modelId: 'unnamed' }] } }) }), {
    availableModels: [{ modelId: 'unnamed', name: 'unnamed' }],
  });
  for (const availableModels of [[], [null], [{}], [{ modelId: '' }], [{ modelId: 'm', name: {} }]])
    await assert.rejects(grok.readModels({ request: async () => ({ result: { availableModels } }) }), /did not list/);
  for (const reply of [null, {}, { error: 'nope', result: { availableModels: models } }, { result: { availableModels: {} } }])
    await assert.rejects(
      grok.readModels({ init: { _meta: { modelState: { availableModels: [] } } }, request: async () => reply }),
      /did not list/,
    );
  await assert.rejects(
    grok.readModels({
      request: async () => {
        throw new Error('offline');
      },
    }),
    /offline/,
  );
  const noListing: any = {};
  const ignored: any[] = [];
  const reportIgnored = (...args: any[]) => ignored.push(args);
  await initialModels(noListing, {}, reportIgnored);
  assert.equal(ignored.length, 0);
  assert.equal(noListing.initialModels, undefined);
  await initialModels(
    noListing,
    {
      label: 'Native',
      readModels: async () => {
        throw new Error('offline');
      },
    },
    reportIgnored,
  );
  assert.equal(noListing.initialModels, undefined, 'an optional listing failure never becomes an empty successful catalog');
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0][0], 'list Native models');
  assert.match(ignored[0][1].message, /offline/);
});

test('Grok extension envelopes reach the owning live chat once and replay stays out of its transcript', async () => {
  const t = setup({
    quirks: Q.quirks,
    handlers: {
      initialize: () => INIT({ loadSession: true }, { _meta: { modelState: { availableModels: [{ modelId: 'grok/m', name: 'M' }] } } }),
    },
  });
  try {
    const chat = await t.host.ensure('acp:grok:a', { cwd: dir });
    assert.deepEqual(chat.state.models, { availableModels: [{ modelId: 'grok/m', name: 'M' }] });
    const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live' } };
    for (const method of ['session/update', ...Object.keys(grok.extensions)]) {
      chat.agent.proc.notify(method, { sessionId: chat.sessionId, update });
      chat.agent.proc.notify(method, { sessionId: chat.sessionId, update, _meta: { isReplay: true } });
      chat.agent.proc.notify(method, {
        sessionId: chat.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'historical', kind: 'execute' },
        _meta: { isReplay: true },
      });
    }
    chat.agent.proc.notify('x.ai/session/update', { sessionId: 'another', update });
    assert.equal(t.events.filter((e: any) => e.kind === 'update').length, 5);
    assert.equal(
      t.events.some((e: any) => e.kind === 'unattended'),
      false,
    );
    assert.deepEqual(grok.extensions['x.ai/session/update'](null), { update: undefined });
  } finally {
    t.host.closeAll();
  }
});

test('Grok model discovery reaches both admission and new-chat catalog publication', async () => {
  const models = { availableModels: [{ modelId: 'grok/m', name: 'M' }] };
  const { probe } = require('../electron/harness/admission.cjs');
  const { fakeSpawn } = await import('./support/acp-host/fixture.ts');
  const sp = fakeSpawn({
    initialize: () => INIT({ loadSession: true }),
    'x.ai/models/list': () => ({ result: models }),
  });
  const result = await probe('grok', {
    quirks: Q.quirks,
    resolveBin: () => '/tools/grok',
    env: () => ({}),
    dataDir: dir,
    spawnFn: sp.spawnFn,
    tools: { prepare: async () => ({ mcpServers: [] }), admission: async () => true, end: () => {} },
  });
  assert.equal(result.state, 'admitted');
  assert.deepEqual(result.catalog.models, models);
  const catalogs: any[] = [];
  const t = setup({
    quirks: Q.quirks,
    admission: { noteCatalog: (...args: any[]) => catalogs.push(args) },
    handlers: { initialize: () => INIT({ loadSession: true }), 'x.ai/models/list': () => ({ result: models }) },
  });
  try {
    await t.host.ensure('acp:grok:a', { cwd: dir });
    assert.deepEqual(catalogs, [['grok', { modes: null, configOptions: null, models }]]);
  } finally {
    t.host.closeAll();
  }
});

test('a session model catalog wins discovery, and unavailable discovery preserves replayed settings', async () => {
  const sessionModels = { currentModelId: 'session', availableModels: [{ modelId: 'session', name: 'Session' }] };
  const available = setup({
    quirks: Q.quirks,
    handlers: {
      initialize: () => INIT({ loadSession: true }, { _meta: { modelState: { availableModels: [{ modelId: 'init' }] } } }),
      'session/new': () => ({ sessionId: 'new', models: sessionModels }),
    },
  });
  const missing = setup({
    quirks: Q.quirks,
    handlers: {
      initialize: () => INIT({ loadSession: true }),
      'session/load': (params: any, proc: any) => {
        proc.notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'ask' },
        });
        return {};
      },
    },
  });
  try {
    assert.deepEqual((await available.host.ensure('acp:grok:a', { cwd: dir })).state.models, sessionModels);
    missing.items.append('acp:grok:old', { t: 'session', sessionId: 'saved', cwd: dir });
    const chat = await missing.host.ensure('acp:grok:old');
    assert.equal(chat.state.models, null);
    assert.equal(chat.state.modes.currentModeId, 'ask');
    assert.equal(
      missing.events.some((e: any) => e.kind === 'update'),
      false,
    );
  } finally {
    available.host.closeAll();
    missing.host.closeAll();
  }
});

test('OMP preserves ordinary MCP output and canonical command exit evidence', () => {
  const result = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'mcp',
    kind: 'other',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Important MCP result' } }],
    rawOutput: { content: [{ type: 'text', text: 'Important MCP result' }] },
  };
  assert.equal(omp.normalizeUpdate(result), result);
  assert.deepEqual(toolItem(omp.normalizeUpdate(result), dir), toolItem(result, dir));
  for (const [rawOutput, output, exit] of [
    [{ content: [{ type: 'text', text: 'failure' }], exitCode: 7 }, 'failure', 7],
    [{ content: [{ type: 'text', text: 'failure' }], output: 'canonical' }, 'canonical', null],
    [{ content: [{ type: 'text', text: '$ false' }] }, '$ false', null],
    [{ content: [], exit_code: 7 }, '', 7],
    [{ content: [], output_for_prompt: 'canonical' }, 'canonical', null],
    [{ content: [], signal: 'SIGTERM' }, '', null],
    [{ content: [], timed_out: true }, '', null],
    [{ stdout: 'out', stderr: 'err', exitCode: 0 }, 'out\nerr', 0],
    [{ stdout: '', output: 'stale' }, '', null],
    [{ stderr: 'known' }, 'known', null],
    [null, '', null],
    [{}, '', null],
    [[], '', null],
    ['raw text', 'raw text', null],
  ] as const) {
    const command = { ...result, kind: 'execute', content: [{ type: 'content', content: { type: 'text', text: '$ false' } }], rawOutput };
    const normalized = omp.normalizeUpdate(command);
    const item = toolItem(normalized, dir);
    assert.equal(item.aggregatedOutput, output);
    assert.equal(item.exitCode, exit);
    if (rawOutput && !Array.isArray(rawOutput) && typeof rawOutput === 'object')
      for (const [key, value] of Object.entries(rawOutput)) if (key !== 'output') assert.deepEqual(normalized.rawOutput[key], value);
  }
});

test('OMP structured output reaches command cards, with only explicit exit evidence and non-text content retained', async () => {
  const update = (details?: any) => ({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'cmd',
    kind: 'execute',
    status: 'completed',
    content: [
      { type: 'content', content: { type: 'text', text: '$ echo old' } },
      { type: 'terminal', terminalId: 't' },
    ],
    rawOutput: { content: [{ type: 'text', text: 'actual' }, null, { type: 'image' }], ...(details ? { details } : {}) },
  });
  for (const [details, exit] of [
    [undefined, null],
    [{ async: true }, null],
    [{ service: true }, null],
    [{ exitCode: 7 }, 7],
    [{ exitCode: 0 }, 0],
  ] as const) {
    const normalized = omp.normalizeUpdate(update(details));
    assert.deepEqual(normalized.content, [
      { type: 'content', content: { type: 'text', text: 'actual' } },
      { type: 'terminal', terminalId: 't' },
    ]);
    const item = toolItem(normalized, dir);
    assert.equal(item.aggregatedOutput, 'actual');
    assert.equal(item.exitCode, exit);
  }
  assert.equal(omp.normalizeUpdate(null), null);
  assert.equal(omp.normalizeUpdate({ sessionUpdate: 'usage_update' }).sessionUpdate, 'usage_update');
  assert.equal(
    toolItem(omp.normalizeUpdate({ ...update(), content: undefined, rawOutput: { content: [null] } }), dir).aggregatedOutput,
    null,
  );
  const extraContent = { type: 'content', content: { type: 'text', text: 'extra context' } };
  const u = update();
  u.content.push({ type: 'content', content: { type: 'text', text: 'actual' } }, extraContent);
  assert.deepEqual(omp.normalizeUpdate(u).content, [
    { type: 'content', content: { type: 'text', text: 'actual' } },
    { type: 'terminal', terminalId: 't' },
    extraContent,
  ]);
  assert.equal(toolItem(omp.normalizeUpdate(u), dir).aggregatedOutput, 'actual\nextra context');
  const canonical = { ...update(), rawOutput: { output: 'canonical' } };
  canonical.content.push({ type: 'content', content: { type: 'text', text: 'canonical' } });
  assert.equal(toolItem(omp.normalizeUpdate(canonical), dir).aggregatedOutput, 'canonical');
  for (const content of [[], [null], [{ type: 'content' }], [{ type: 'content', content: { type: 'text', text: 1 } }]]) {
    const malformed = { ...update(), content };
    assert.equal(omp.normalizeUpdate(malformed), malformed);
  }
  assert.equal(toolItem({ kind: 'execute', rawOutput: { exitCode: 'bad' } }, dir).exitCode, null);
  const t = setup({ quirks: Q.quirks, handlers: { initialize: () => INIT({ loadSession: true }) } });
  try {
    const chat = await t.host.ensure('acp:omp:a', { cwd: dir });
    // A replay updates state only; a live turn owns recorded tool activity.
    chat.loading = true;
    t.host.record(chat, update({ exitCode: 7 }));
    chat.loading = false;
    chat.prompting = { turnId: 'turn', cancelled: false };
    t.host.record(chat, update({ exitCode: 7 }));
    const event = t.events.find((e: any) => e.kind === 'update');
    assert.equal(event.update.rawOutput.output, 'actual');
    assert.equal(event.update.rawOutput.exitCode, 7);
  } finally {
    t.host.closeAll();
  }
});
