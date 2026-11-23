// The account relay's address reaches Codex with each thread request, never on its command line (#2144):
// withRelay (electron/identity/accounts/relayConfig.cjs) and the adapter's thread/start, resume and fork
// (electron/harness/codexConnection.cjs call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CodexAdapter } from './support/codex-harness/fixture';

const { withRelay } = createRequire(import.meta.url)('../electron/identity/accounts/relayConfig.cjs');
const RELAY = { openai_base_url: 'http://127.0.0.1:1/secret', experimental_realtime_ws_base_url: 'http://127.0.0.1:1/secret/v1/live' };

test('withRelay adds the relay to a thread’s config; keys the request sets itself win; no relay leaves it alone', () => {
  assert.deepEqual(withRelay({ cwd: '/p' }, RELAY), { cwd: '/p', config: RELAY });
  assert.deepEqual(withRelay({ config: { model: 'm', openai_base_url: 'https://own' } }, RELAY), {
    config: { ...RELAY, model: 'm', openai_base_url: 'https://own' },
  });
  assert.deepEqual(withRelay({ config: ['not', 'a', 'record'] }, RELAY), { config: RELAY });
  assert.deepEqual(withRelay(undefined, RELAY), { config: RELAY });
  const params = { cwd: '/p' };
  assert.equal(withRelay(params, null), params);
  assert.deepEqual(withRelay(null, undefined), {});
});

test('thread/start, resume and fork carry the relay; other requests do not', () => {
  const sent: any[] = [];
  const server = { listeners: new Set(), send: (m: any) => sent.push(m), threadConfig: RELAY };
  const a = new CodexAdapter({ server });
  for (const method of ['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'model/list'])
    a.call(method, { threadId: 't', cwd: '/tmp' }).catch(() => {});
  const byMethod = Object.fromEntries(sent.map((m) => [m.method, m.params]));
  for (const m of ['thread/start', 'thread/resume', 'thread/fork'])
    assert.equal(byMethod[m].config.openai_base_url, RELAY.openai_base_url, m);
  for (const m of ['turn/start', 'model/list']) assert.equal(byMethod[m].config, undefined, m);
  // no relay (skipped, or it did not start): nothing is added
  server.threadConfig = null as any;
  a.call('thread/resume', { threadId: 't' }).catch(() => {});
  assert.equal(sent.at(-1).params.config, undefined);
});
