// The window's Remote Control action (src/session/harness/claude/remoteControl.ts): what is asked of main for the chat's
// Claude Code session, and that every way it can fail is said in a toast.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubStore } from './support/stubs.ts';
import { useFakeNative } from './support/ports/native.ts';

const toasts: [string, string | undefined][] = [];
stubStore({
  getState: () => ({ threads: { t1: { name: 'Fix the build' }, t2: {} } }),
  threadTitle: (t: any) => t?.name ?? 'New chat',
  toast: (text: string, kind?: string) => toasts.push([text, kind]),
  nativeOf: (id: string) => `claude:${id}`,
});
const { setRemoteControl } = await import('../src/session/harness/claude/remoteControl.ts');

beforeEach(() => {
  toasts.length = 0;
});

const answering = (t: any, reply: () => unknown) => {
  const asked: unknown[][] = [];
  useFakeNative(t, { claude: { control: async (...a: unknown[]) => (asked.push(a), reply()) } });
  return asked;
};

test("turning it on asks the chat's session with the chat title, and a link says nothing", async (t) => {
  const asked = answering(t, () => ({ state: 'on', url: 'https://claude.ai/code/session_a', error: null, wanted: true }));
  await setRemoteControl('t1', true);
  await setRemoteControl('t2', true);
  assert.deepEqual(asked, [
    ['claude:t1', 'remoteControl', { on: true, title: 'Fix the build' }],
    ['claude:t2', 'remoteControl', { on: true, title: 'New chat' }],
  ]);
  assert.deepEqual(toasts, []);
});

test('turning it off says nothing, even when the link was already gone', async (t) => {
  const asked = answering(t, () => ({ state: 'off', url: null, error: null, wanted: false }));
  await setRemoteControl('t1', false);
  assert.equal((asked[0] as any[])[2].on, false);
  assert.deepEqual(toasts, []);
});

test('a session that is not running, a connect that failed and a login that cannot are each said', async (t) => {
  answering(t, () => null);
  await setRemoteControl('t1', true);
  assert.deepEqual(toasts.pop(), ['Remote Control links a running Claude Code session. Send a message first.', 'error']);

  useFakeNative(t, {
    claude: { control: async () => ({ state: 'error', url: null, error: 'Remote Control did not connect in time', wanted: true }) },
  });
  await setRemoteControl('t1', true);
  assert.deepEqual(toasts.pop(), ['Remote Control did not connect in time', 'error']);

  useFakeNative(t, { claude: { control: async () => ({ state: 'unavailable', url: null, error: null, wanted: false }) } });
  await setRemoteControl('t1', true);
  assert.deepEqual(toasts.pop(), ["Couldn't connect Remote Control", 'error']);
});

test('a request that fails is a toast naming what was asked', async (t) => {
  useFakeNative(t, {
    claude: {
      control: async () => {
        throw new Error('ipc closed');
      },
    },
  });
  await setRemoteControl('t1', true);
  await setRemoteControl('t1', false);
  assert.equal(toasts.length, 2);
  assert.match(toasts[0][0], /^Couldn't turn on Remote Control: .*ipc closed/);
  assert.match(toasts[1][0], /^Couldn't turn off Remote Control: /);
  assert.equal(toasts[0][1], 'error');
});
