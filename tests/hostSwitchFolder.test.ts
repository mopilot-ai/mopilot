// The folder a chat runs in, as the runtime reports it (host/src/hostSwitch.mjs `switchRuntime().folderOf`, R2b of #5576): the switcher's own reading of the chat's session, null for a chat this Host has no record of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { switchRuntime } from '../host/src/hostSwitch.mjs';

const make = (known: string[], folderOf: (id: string) => Promise<string | null | undefined>) =>
  switchRuntime({
    chats: { records: new Map(known.map((id) => [id, {}])) },
    state: { has: () => false },
    controller: () => ({ ref: () => ({ kind: 'claude' }) }),
    provided: { acp: true, claude: true, codex: true },
    labels: {},
    hold: () => undefined,
    folderOf,
  });

test("a chat's folder is the switcher's reading of its session; a chat this Host has no record of has none, and nothing is asked", async () => {
  const asked: string[] = [];
  const r = make(['claude:a'], async (id) => (asked.push(id), '/proj'));
  assert.equal(await r.folderOf('claude:a'), '/proj');
  assert.equal(await r.folderOf('claude:nope'), null);
  assert.deepEqual(asked, ['claude:a']);
  const none = make(['claude:a'], async () => undefined);
  assert.equal(await none.folderOf('claude:a'), null, 'a session that says nothing has no folder to look at');
});

test('a Host that knows a chat by its state alone is asked too', async () => {
  const r = switchRuntime({
    chats: { records: new Map() },
    state: { has: (id: string) => id === 'claude:s' },
    controller: () => ({ ref: () => ({ kind: 'claude' }) }),
    provided: { acp: true, claude: true, codex: true },
    labels: {},
    hold: () => undefined,
    folderOf: async () => '/state',
  });
  assert.equal(await r.folderOf('claude:s'), '/state');
});

test("the runtime's folder reader asks the switcher about the chat's own reference", async () => {
  const { folderReader } = await import('../host/src/hostSwitch.mjs');
  const asked: unknown[] = [];
  const read = folderReader({
    switcher: { cwdOf: async (ref: unknown) => (asked.push(ref), '/where') },
    controller: () => ({ ref: (id: string) => ({ kind: 'claude', id }) }),
  });
  assert.equal(await read('claude:x'), '/where');
  assert.deepEqual(asked, [{ kind: 'claude', id: 'claude:x' }]);
});
