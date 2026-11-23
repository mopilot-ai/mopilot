// Native settings helpers preserve ordered mutations, process lifetime and plan return modes through rejection, retirement and retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { mutateNativeSettings, setNativePermission, applyNativeFlags } = require('../electron/harness/claude/nativeSettings.cjs');

test('native mutation queues combine independent work and failures release their successors', async () => {
  const session = {};
  const gate = deferred<void>();
  const events: string[] = [];
  const first = mutateNativeSettings(
    session,
    () => {},
    async () => {
      events.push('first');
      await gate.promise;
      throw new Error('failed');
    },
  );
  const rejected = assert.rejects(first, /failed/);
  const next = mutateNativeSettings(
    session,
    () => {},
    async () => {
      events.push('next');
      return 2;
    },
  );
  const other = mutateNativeSettings(
    {},
    () => {},
    async () => {
      events.push('other');
      return 3;
    },
  );
  assert.equal(await other, 3);
  assert.deepEqual(events, ['first', 'other']);
  gate.resolve();
  await rejected;
  assert.equal(await next, 2);
  assert.deepEqual(events, ['first', 'other', 'next']);
});

test('permission acknowledgments update plan return mode only while current; rejected changes remain retryable', async () => {
  const modes: string[] = [];
  const session = {
    restoreMode: 'default',
    q: {
      setPermissionMode: async (mode: string) => {
        modes.push(mode);
        return 'ack';
      },
    },
  };
  assert.equal(await setNativePermission(session, 'full-access', () => {}), 'ack');
  assert.equal(session.restoreMode, 'bypassPermissions');
  await setNativePermission(session, 'plan', () => {});
  assert.equal(session.restoreMode, 'bypassPermissions');
  session.q.setPermissionMode = async () => {
    throw new Error('refused');
  };
  await assert.rejects(
    setNativePermission(session, 'default', () => {}),
    /refused/,
  );
  assert.equal(session.restoreMode, 'bypassPermissions');
  let active = true;
  session.q.setPermissionMode = async () => {
    active = false;
    return 'ack';
  };
  await assert.rejects(
    setNativePermission(session, 'default', () => {
      if (!active) throw new Error('retired');
    }),
    /retired/,
  );
  assert.equal(session.restoreMode, 'bypassPermissions');
  active = true;
  session.q.setPermissionMode = async (mode: string) => {
    modes.push(mode);
    return 'ack';
  };
  await setNativePermission(session, 'default', () => {});
  assert.equal(session.restoreMode, 'default');
  assert.deepEqual(modes, ['bypassPermissions', 'plan', 'default']);
});

test('flag changes read unknown ultracode state only when needed and refresh failure cannot turn an applied mutation into failure', async () => {
  for (const [patch, initial, prior, expected] of [
    [{ effortLevel: 'high' }, undefined, true, { effortLevel: 'high', ultracode: true }],
    [{ effortLevel: 'low' }, false, true, { effortLevel: 'low', ultracode: false }],
    [{ ultracode: true }, undefined, false, { ultracode: true }],
    [{ model: 'sonnet' }, undefined, false, { model: 'sonnet' }],
    [null, undefined, false, {}],
  ] as any[]) {
    const calls: any[] = [];
    const session: any = { ultracode: initial, q: { applyFlagSettings: async (value: any) => calls.push(value) } };
    let reads = 0;
    assert.equal(
      await applyNativeFlags(
        session,
        patch,
        () => {},
        async () => {
          reads++;
          return { ultracode: prior };
        },
      ),
      true,
    );
    assert.deepEqual(calls, [expected]);
    assert.equal(reads, patch?.effortLevel && initial === undefined ? 2 : 1);
  }
  const session = { q: { applyFlagSettings: async () => {} } };
  assert.equal(
    await applyNativeFlags(
      session,
      { ultracode: false },
      () => {},
      async () => {
        throw new Error('display refresh failed');
      },
    ),
    true,
  );
});

test('retirement or rejection while reading flags sends no mutation and a later retry still applies', async () => {
  const calls: any[] = [];
  const session = { q: { applyFlagSettings: async (value: any) => calls.push(value) } };
  let active = true;
  const current = () => {
    if (!active) throw new Error('retired');
  };
  await assert.rejects(
    applyNativeFlags(session, { effortLevel: 'high' }, current, async () => {
      active = false;
      return {};
    }),
    /retired/,
  );
  active = true;
  await assert.rejects(
    applyNativeFlags(session, { effortLevel: 'high' }, current, async () => {
      throw new Error('read failed');
    }),
    /read failed/,
  );
  assert.deepEqual(calls, []);
  assert.equal(await applyNativeFlags(session, { effortLevel: 'high' }, current, async () => ({})), true);
  assert.deepEqual(calls, [{ effortLevel: 'high' }]);
});
