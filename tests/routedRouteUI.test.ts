// Claude Code's route while it runs on Your own provider (src/harness/routes.ts withRouted, RouteNotice): MoPilot's own route
// ('mopilot-routed', named after the model config) while Claude Code's settings leave it direct; while its settings.json sends it to an
// endpoint or a cloud, that wins and the notice says routing is off; Codex and a route that can't be read are left as read.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

let changed: (list: any[]) => void = () => {};
installNativeStub({
  routes: {
    list: async () => [],
    refresh: async () => [],
    onChanged: (cb: (list: any[]) => void) => ((changed = cb), () => {}),
    reveal: async () => true,
    restartIdle: async () => ({ restarted: 0, busy: 0 }),
  },
});
stubStore({ toast: () => {} });
mock.module('../src/lib/paths.ts', { namedExports: { abbreviateHome: (p: string) => p.replace('/Users/u', '~') } });

const routes = await import('../src/harness/routes.ts');
// the renderer's types for routed mode, as the windows load them
await import('../src/lib/native/routes.ts');
await import('../src/lib/native/claude.ts');
await import('../src/lib/native/ledger.ts');
await import('../src/lib/native/contracts/harnesses.ts');
const { publishClaudeKey } = await import('../src/harness/claudeKeyState.ts');
const { RouteNotice } = await import('../src/components/harness/RouteNotice.tsx');

const entry = (p: any = {}) => ({
  harness: 'claude',
  kind: 'direct',
  router: null,
  label: null,
  endpoint: null,
  loopback: false,
  model: null,
  provider: null,
  cloud: null,
  catalog: null,
  reasons: [],
  sources: [],
  file: null,
  error: null,
  signature: 's',
  changedAt: 1,
  lastGood: null,
  stale: { running: 0, idle: 0 },
  effects: [],
  ...p,
});
const key = (mode: string, name: string | null = 'Work') =>
  ({
    set: false,
    hint: null,
    mode,
    baseUrl: null,
    cloudEnv: false,
    cloudDetected: false,
    routed: { available: true, configId: 'c1', name },
  }) as any;

test('withRouted: MoPilot’s route while the config is direct; the config wins where it names an endpoint or a cloud', () => {
  const routed = { label: 'Work' };
  assert.equal(routes.withRouted(null, routed), null);
  const direct = entry();
  assert.equal(routes.withRouted(direct as any, null), direct, 'not routed: as read');
  const mine = routes.withRouted(direct as any, routed)!;
  assert.equal(mine.kind, 'mopilot-routed');
  assert.equal(mine.label, 'Work');
  assert.equal(routes.routeTag(mine), 'via Work');
  assert.equal(routes.routeName(mine), 'Work');
  assert.match(
    routes.routeSentence(mine, 'Claude Code'),
    /^MoPilot sends Claude Code's requests to your own provider \(Work\) through its model router/,
  );
  assert.equal(routes.routeShown(mine), true);
  // a model alone set in settings.json still goes through the router
  assert.equal(routes.withRouted(entry({ kind: 'external', reasons: ['model'], model: 'opus' }) as any, routed)!.kind, 'mopilot-routed');
  for (const reasons of [['endpoint'], ['cloud'], ['router', 'endpoint']]) {
    const out = routes.withRouted(entry({ kind: 'external', reasons, label: 'gw.example' }) as any, routed)!;
    assert.equal(out.kind, 'external', reasons.join());
    assert.deepEqual(out.effects, ['routedOff']);
  }
  const unknown = entry({ kind: 'unknown', error: 'bad json' });
  assert.equal(routes.withRouted(unknown as any, routed), unknown);
  assert.equal(routes.routedOf(null), null);
  assert.equal(routes.routedOf(key('apiKey')), null);
  assert.deepEqual(routes.routedOf(key('routed')), { label: 'Work' });
  assert.deepEqual(routes.routedOf(key('routed', null)), { label: 'a removed model config' });
});

test('the notice: Your own provider for Claude Code while chosen, and routing off when its settings.json routes it elsewhere', async () => {
  const v = await render(
    h('div', null, h(RouteNotice, { harness: 'claude', label: 'Claude Code' }), h(RouteNotice, { harness: 'codex', label: 'Codex' })),
  );
  changed([entry(), entry({ harness: 'codex' })]);
  await flush();
  assert.equal(v.host.querySelector('[data-route]'), null, 'direct, not routed: nothing to say');
  publishClaudeKey(key('routed'));
  await flush();
  assert.match(v.host.querySelector('[data-route="claude"]')!.textContent!, /via Work.*your own provider \(Work\)/);
  assert.equal(v.host.querySelector('[data-route="codex"]'), null, 'Codex is never routed here');
  changed([
    entry({
      kind: 'external',
      reasons: ['endpoint'],
      label: 'gw.example',
      endpoint: 'https://gw.example',
      file: '/Users/u/.claude/settings.json',
    }),
  ]);
  await flush();
  assert.match(
    v.host.querySelector('[data-route="claude"]')!.textContent!,
    /~\/\.claude\/settings\.json sends requests to gw\.example, so your own provider is off\./,
  );
  changed([entry({ kind: 'external', reasons: ['cloud'], cloud: 'Amazon Bedrock', label: 'Amazon Bedrock' })]);
  await flush();
  assert.match(
    v.host.querySelector('[data-route="claude"]')!.textContent!,
    /Its own config sends requests to Amazon Bedrock, so your own provider is off/,
  );
  changed([entry({ kind: 'external', reasons: ['endpoint'], label: null })]);
  await flush();
  assert.match(
    v.host.querySelector('[data-route="claude"]')!.textContent!,
    /Its own config sends requests to another endpoint, so your own provider is off/,
  );
  publishClaudeKey(key('subscription'));
  await flush();
  assert.doesNotMatch(v.host.querySelector('[data-route="claude"]')!.textContent!, /your own provider/);
  await v.unmount();
});
