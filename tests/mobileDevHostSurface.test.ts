// The dev host's surface scenario: where a chat's agent works, as the fake Mac answers surface.current for the chat header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createScenarios } from '../scripts/mobile-dev-host/scenarios.mjs';

function rig() {
  const app = createFakeApp({
    repo: '/repo',
    log: () => undefined,
    now: () => 9_000_000,
    sleep: async () => undefined,
    status: async () => '',
  });
  app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
  const scenarios = createScenarios({ app, now: () => 9_000_000, after: () => undefined, controls: undefined as any });
  const chatIn = (message: string) => /chat (dev-bench-\d+)/.exec(message)![1];
  return { app, ops: app.ops, run: (name: string, args?: string[]) => scenarios.run(name, args) as string, chatIn };
}

test('surface says where a chat’s agent works, as the Mac answers surface.current, and clears it', async () => {
  const r = rig();
  const id = r.chatIn(r.run('slow-stream', ['1']));
  assert.deepEqual(await r.ops.surface(id), {}, 'nothing before the first browser or desktop step');
  assert.match(r.run('surface', [id, 'https://shop.example.com']), /browser at https:\/\/shop\.example\.com$/);
  assert.deepEqual(await r.ops.surface(id), { kind: 'iab', origin: 'https://shop.example.com' });
  assert.match(r.run('surface', [id, 'about:blank', 'Cart', 'page']), /\(title "Cart page"\)/);
  assert.deepEqual(await r.ops.surface(id), { kind: 'iab', origin: 'about:blank', title: 'Cart page' });
  assert.match(r.run('surface', [id, 'desktop', 'Notes']), /desktop app Notes/);
  assert.deepEqual(await r.ops.surface(id), { kind: 'desktop', app: { name: 'Notes' } });
  assert.match(r.run('surface', [id, 'desktop']), /desktop app Notes/, 'Notes unless an app is named');
  assert.match(r.run('surface', [id, '-']), /no surface/);
  assert.deepEqual(await r.ops.surface(id), {});
  assert.throws(() => r.run('surface', [id, 'http://plain.example']), /Say an https origin/);
  assert.throws(() => r.run('surface', [id]), /Say an https origin/);
  assert.throws(() => r.run('surface', ['nope', '-']), /No chat nope/);
  assert.throws(() => r.run('surface', []), /No chat \./);
  await r.app.idle();
});
