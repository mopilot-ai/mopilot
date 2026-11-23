// Asking the OS for the push token makes it announce the token again; the registration must not answer each announcement by asking again (3,500 reconciles in 1.2 s on a real iPhone at launch).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPushRegistration } from '../mobile/src/push/registration.ts';

const tick = () => new Promise((r) => setImmediate(r));

function rig() {
  let listener: ((t?: string | null) => void) | null = null;
  const log = { gets: 0, registers: [] as string[] };
  let token = 'tok1';
  const reg = createPushRegistration({
    relay: { register: async (_p, t) => void log.registers.push(t), unregister: async () => undefined },
    tokens: {
      platform: 'apns',
      // like the OS: every ask is also announced, the way expo's device token listener hears it
      get: async () => (log.gets++, setImmediate(() => log.gets < 200 && listener?.(token)), token),
      onRefresh: (l) => ((listener = l), () => (listener = null)),
    },
    store: { read: async () => null, write: async () => undefined },
  });
  return { reg, log, announce: (t?: string | null) => listener?.(t), setToken: (t: string) => (token = t) };
}

test('an announcement of the token just read does not start another read; a new token does', async () => {
  const r = rig();
  await r.reg.enable();
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(r.log.registers, ['tok1']);
  assert.ok(r.log.gets <= 2, `asked the OS ${r.log.gets} times`);
  const before = r.log.gets;
  r.announce('tok1');
  r.announce(null);
  await tick();
  assert.equal(r.log.gets, before + 1, 'one announcement without a token still checks once; the one of the known token does not');
  // a rotation: the announced token differs from the one seen, so it is read and registered once
  r.setToken('tok2');
  r.announce('tok2');
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(r.log.registers, ['tok1', 'tok2']);
  assert.ok(r.log.gets < 10);
});
