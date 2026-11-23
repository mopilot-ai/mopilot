// A control request whose handler throws, synchronously or after an await, costs only that request (frames that fail to store: relayStoreFailure.test.ts): the other connections keep exchanging frames, the relay stays up, and the process guards' counts show on /metrics.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { freePort } from '../scripts/relay-load/relayHost.mjs';
import WebSocket from 'ws';
import { start } from '../relay/src/main.mjs';
import { installProcessGuards, processErrors } from '../relay/src/processGuards.mjs';
import { makeDb, makeKeys } from './support/relayKit.ts';

const keys = await makeKeys();
const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64');

test('requests that throw in the database layer leave other connections, other pairs and the relay itself untouched', async () => {
  const { db } = await makeDb();
  const poison = (params?: unknown[]) => params?.find((p) => typeof p === 'string' && p.startsWith('POISON-')) as string | undefined;
  let hits = 0;
  const hostile = {
    query: (sql: string, params?: unknown[]) => {
      const p = poison(params);
      if (p) hits++;
      if (p === 'POISON-SYNC') throw new Error('thrown before any await');
      if (p) return Promise.reject(Object.assign(new Error(`rejected after an await: "${p}"`), { code: '22P02' }));
      return db.query(sql, params as any);
    },
    transaction: (fn: any) => db.transaction(fn),
  };
  const events: [string, any][] = [];
  const proc = new EventEmitter();
  installProcessGuards({ proc: proc as any, log: (e, d) => events.push([e, d]), exit: () => assert.fail('the process must not be ended') });
  const started = await start(
    {
      AUTH_PUBLIC_KEY: keys.publicPem,
      DATABASE_URL: 'postgres://unused',
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
      METRICS_TOKEN: 'isolation-token-12345',
    },
    { pool: hostile as any, log: (e, d) => events.push([e, d]) },
  );
  const base = `http://127.0.0.1:${started.port}`;
  const open = async (user: string, device: string, kind: 'desktop' | 'phone') => {
    const ws = new WebSocket(`ws://127.0.0.1:${started.port}/v1/ws`, {
      headers: { authorization: `Bearer ${await keys.sign(user, device, { kind })}` },
    });
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
    ws.on('error', () => undefined);
    await new Promise((resolve) => ws.once('open', resolve));
    await waitFor(() => inbox.some((m) => m.t === 'hello'), 'the hello message');
    return { ws, inbox, send: (m: object) => ws.send(JSON.stringify(m)) };
  };
  try {
    // an honest pair, and a device that keeps asking the database to fail
    const mac = await open('honest', 'mac-h', 'desktop');
    const phone = await open('honest', 'phone-h', 'phone');
    const bad = await open('bad', 'phone-bad', 'phone');
    mac.send({ t: 'pair.register', pair: 'p_isolation1' });
    await waitFor(() => mac.inbox.some((m) => m.t === 'ok' && m.op === 'pair.register'), 'the honest pair registration');
    phone.send({ t: 'pair.join', pair: 'p_isolation1' });
    await waitFor(() => phone.inbox.some((m) => m.t === 'ok' && m.op === 'pair.join'), 'the honest phone joining');
    for (let i = 0; i < 20; i++) {
      bad.send({ t: 'push.register', platform: 'apns', token: i % 2 ? 'POISON-SYNC' : `POISON-ASYNC-${i}` });
      mac.send({ t: 'frame', pair: 'p_isolation1', dir: 'm2p', ctr: i + 1, nonce: b64(24), box: b64(64) });
    }
    await waitFor(
      () => phone.inbox.filter((m) => m.t === 'frame').length === 20 && events.filter(([e]) => e === 'error').length === 20,
      'all honest frames and hostile request errors',
    );
    const got = phone.inbox.filter((m) => m.t === 'frame').map((m) => m.ctr);
    assert.deepEqual(
      got,
      Array.from({ length: 20 }, (_, i) => i + 1),
      'every frame of the honest pair arrived, in order, while the other device failed',
    );
    assert.equal(mac.ws.readyState, WebSocket.OPEN);
    assert.equal(phone.ws.readyState, WebSocket.OPEN);
    assert.ok(!bad.inbox.some((m) => m.t === 'ok' && m.op === 'push.register'), 'the failing requests were not reported as done');
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    // the errors were logged as the request's own, not as the process's
    assert.ok(
      events.some(([e]) => e === 'error'),
      'the failures were logged',
    );
    assert.equal(hits, 20, 'every poisoned request reached the failing database');

    // what the guards catch is counted and scraped
    proc.emit('unhandledRejection', new Error('stray'));
    proc.emit('unhandledRejection', new Error('stray again'));
    proc.emit('uncaughtException', Object.assign(new Error('dead socket'), { code: 'ECONNRESET' }));
    const scrape = async () =>
      (await (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer isolation-token-12345' } })).text()).split('\n');
    const line = (lines: string[], event: string) => lines.find((l) => l.startsWith(`relay_process_errors_total{event="${event}"}`));
    const value = (lines: string[], event: string) => Number(line(lines, event)?.split(' ').at(-1));
    const first = await scrape();
    const rejections = value(first, 'unhandled_rejection');
    const uncaught = value(first, 'uncaught_exception');
    assert.ok(processErrors.unhandled_rejection >= 2 && processErrors.uncaught_exception >= 1, 'the guards counted what they caught');
    assert.equal(rejections, processErrors.unhandled_rejection);
    // the next scrape adds exactly what happened since: one rejection and no uncaught error
    proc.emit('unhandledRejection', new Error('one more'));
    const second = await scrape();
    assert.equal(value(second, 'unhandled_rejection'), rejections + 1);
    assert.equal(value(second, 'uncaught_exception'), uncaught);
    mac.ws.close();
    phone.ws.close();
    bad.ws.close();
  } finally {
    await started.relay.close();
  }
});
