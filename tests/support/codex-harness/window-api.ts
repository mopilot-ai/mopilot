// Codex harness window-api unit cases with shared server and session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_API, thread, setup } from './fixture';

export function registerWindowApiCases() {
  test('the window API: each call is one request with the parameters the store used to send', async () => {
    const { a, server } = setup({}, { segments: { none: null } });
    const calls: [string, any[], string, any][] = [
      ['accountRateLimits', [], 'account/rateLimits/read', {}],
      ['logout', [], 'account/logout', {}],
      ['configRead', [], 'config/read', { includeLayers: false }],
      ['configRequirementsRead', [], 'configRequirements/read', {}],
      ['threadRead', ['t'], 'thread/read', { threadId: 't' }],
      ['threadUnarchive', ['t'], 'thread/unarchive', { threadId: 't' }],
      ['threadGoal', ['none'], 'thread/goal/get', { threadId: 'none' }],
      ['backgroundTerminals', ['none'], 'thread/backgroundTerminals/list', { threadId: 'none' }],
      ['projectList', [], 'project/list', {}],
      ['projectUpdate', ['p', 'n'], 'project/update', { projectId: 'p', name: 'n' }],
      ['projectDelete', ['p'], 'project/delete', { projectId: 'p' }],
      [
        'feedbackUpload',
        [{ classification: 'bug', reason: 'r', threadId: 't' }],
        'feedback/upload',
        { classification: 'bug', reason: 'r', threadId: 't', includeLogs: false },
      ],
      ['externalConfigDetect', [['/a']], 'externalAgentConfig/detect', { includeHome: true, cwds: ['/a'] }],
      ['externalConfigImport', [[{ id: 1 }]], 'externalAgentConfig/import', { migrationItems: [{ id: 1 }] }],
      ['turnInterrupt', ['child', 'turn-3'], 'turn/interrupt', { threadId: 'child', turnId: 'turn-3' }],
      ['mcpStatus', [], 'mcpServerStatus/list', {}],
      ['pluginList', [], 'plugin/list', {}],
      ['skillList', ['/w'], 'skills/list', { cwds: ['/w'], forceReload: false }],
    ];
    for (const [name, args, method, params] of calls) {
      assert.ok(CODEX_API.has(name), name);
      await a.api(name, args);
      assert.deepEqual(server.sent.at(-1), { id: server.sent.at(-1).id, method, params }, name);
    }
    await a.api('accountRateLimits', 'not an array');
    assert.equal(server.sent.at(-1).method, 'account/rateLimits/read');
  });

  test('fork records the new thread and holds it only when asked', async () => {
    let n = 0;
    const { a } = setup({ 'thread/fork': () => (++n === 3 ? {} : { thread: thread(`f${n}`) }) });
    await a.fork({ threadId: 't' });
    assert.ok(a.meta.has('f1'));
    assert.equal(a.leases.has('f1'), false);
    await a.fork({ threadId: 't' }, true);
    assert.ok(a.leases.has('f2'));
    assert.deepEqual(await a.fork({ threadId: 't' }), {});
  });

  test('info: nothing before Codex is up or while down; cached for a while; a failed read is not kept', async () => {
    let models = 0;
    const { a, clock, server } = setup({
      'model/list': () => {
        if (++models === 2) throw new Error('x');
        return { data: [{ model: 'm' }] };
      },
    });
    assert.equal(await a.info(), null);
    await a.initialize();
    const first = await a.info();
    assert.deepEqual(first, { version: '0.50.0', models: [{ model: 'm' }], negotiated: a.negotiated });
    assert.equal(await a.info(), first);
    clock.t += 31_000;
    assert.deepEqual((await a.info()).models, []);
    // the answer without the model list is kept only briefly, then the list is asked for again
    clock.t += 4_000;
    assert.deepEqual((await a.info()).models, []);
    assert.equal(models, 2);
    clock.t += 1_000;
    assert.deepEqual((await a.info()).models, [{ model: 'm' }]);
    assert.equal(models, 3);
    clock.t += 31_000;
    const failing = Promise.reject(new Error('negotiation failed'));
    failing.catch(() => {});
    a.negotiatedP = failing;
    await assert.rejects(a.info(), /negotiation failed/);
    assert.equal(a.infoP, null);
    a.negotiatedP = Promise.resolve(null);
    assert.equal((await a.info()).version, null);
    server.emit({ kind: 'error', error: 'x' });
    assert.equal(await a.info(), null);
  });

  test('defaults: missing config and models leave nulls; models without input modalities say null', async () => {
    const { a } = setup({ 'config/read': () => ({}), 'model/list': () => ({ data: [{ model: 'm' }] }) });
    assert.deepEqual(await a.defaults(), { model: null, effort: null, defaultModel: null, inputs: { m: null } });
    const b = setup({
      'config/read': () => {
        throw new Error('x');
      },
      'model/list': () => {
        throw new Error('x');
      },
    });
    assert.deepEqual(await b.a.defaults(), { model: null, effort: null, defaultModel: null, inputs: {} });
    const c = setup({
      'config/read': () => ({ config: { model: 'cfg', model_reasoning_effort: 'high' } }),
      'model/list': () => ({ data: [{ model: 'd', isDefault: true, inputModalities: ['text'] }] }),
    });
    assert.deepEqual(await c.a.defaults(), { model: 'cfg', effort: 'high', defaultModel: 'd', inputs: { d: ['text'] } });
  });

  test('defaults: a failed read answers nulls for now and is read again; a complete read is kept', async () => {
    let reads = 0;
    const { a } = setup({
      'config/read': () => {
        if (++reads === 1) throw new Error('app-server busy');
        return { config: { model: 'cfg' } };
      },
      'model/list': () => ({ data: [{ model: 'd', isDefault: true }] }),
    });
    assert.deepEqual(await a.defaults(), { model: null, effort: null, defaultModel: 'd', inputs: { d: null } });
    assert.deepEqual(await a.defaults(), { model: 'cfg', effort: null, defaultModel: 'd', inputs: { d: null } });
    await a.defaults();
    assert.equal(reads, 2);
  });
}
