// src/store/runtime.ts: the store reaches the harnesses only through the runtime installed for it, and says so when there
// is none instead of doing nothing; tests/support/ports/runtime.ts's fake names a member a test didn't give.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installRuntime, runtime, type HarnessRuntime } from '../src/store/runtime.ts';
import { fakeRuntime } from './support/ports/runtime.ts';

test('before an install there is no runtime, and a call says main installs it', () => {
  installRuntime(null);
  assert.throws(() => runtime(), /not installed: src\/main\.tsx installs it before boot/);
});

test('an install takes effect at once and hands back the runtime it replaced', () => {
  const first = { startClaude: () => {} } as unknown as HarnessRuntime;
  const second = { startAcp: () => {} } as unknown as HarnessRuntime;
  assert.equal(installRuntime(first), null);
  assert.equal(runtime(), first);
  assert.equal(installRuntime(second), first);
  assert.equal(runtime(), second);
  assert.equal(installRuntime(null), second);
});

test('the fake runs the members it was given and throws, by name, for the rest', async () => {
  const fake = fakeRuntime({ acpLabelOf: (id) => `label:${id}` });
  assert.equal(fake.acpLabelOf('acp:kimi:1'), 'label:acp:kimi:1');
  assert.throws(() => fake.startClaude(), /the harness runtime's startClaude is not stubbed/);
  assert.equal((fake as any)[Symbol.toStringTag], undefined);
});
