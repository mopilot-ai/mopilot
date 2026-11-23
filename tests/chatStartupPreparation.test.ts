// Codex startup overlaps its settings read and the pre-edit baseline with turn/start, keeping every turn setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, settle, thread } from './support/codex-adapter/fixture.ts';
import { deferred } from './support/async-scenarios.ts';

test('startup starts the baseline with the settings read, and turn/start waits only for the settings (#1651)', async () => {
  const settings = deferred();
  const snapshot = deferred();
  let captures = 0;
  let reads = 0;
  const { a, server } = setup(
    {},
    {
      prefs: { model: 'picked', effort: 'ultra', serviceTier: 'priority', permission: 'read-only' },
      turnChanges: {
        begin: () => {
          captures++;
          return snapshot.promise;
        },
        abort() {},
      },
    },
  );
  a.hold('native', thread('native', { preview: 'existing' }));
  a.defaults = () => {
    reads++;
    return settings.promise;
  };
  const send = a.startTurn('native', { kind: 'codex', id: 'native' }, { text: 'hello', attachments: [], opts: {} });
  await settle();
  assert.equal(reads, 1);
  assert.equal(captures, 1, 'baseline must start while defaults are still pending');
  assert.equal(server.methods().includes('turn/start'), false, 'the model cannot run before its settings');
  settings.resolve({ model: 'fallback', effort: 'low', inputs: { picked: ['text', 'image'] } });
  // the snapshot is still being taken: TurnChanges.itemStarted voids it if a tool item beats it
  assert.equal((await send).started, true);
  assert.equal(reads, 1, 'reuse the resolved defaults for modality');
  const params = server.sent.find((m: any) => m.method === 'turn/start').params;
  assert.equal(params.model, 'picked');
  assert.equal(params.effort, 'ultra');
  assert.equal(params.serviceTier, 'priority');
  assert.equal(params.sandboxPolicy.type, 'readOnly');
  snapshot.resolve(undefined);
});

test('failed concurrent preparation aborts its baseline and retry still starts', async () => {
  const settings = deferred();
  const snapshot = deferred();
  const aborted: string[] = [];
  const { a, server, events } = setup({}, { turnChanges: { begin: () => snapshot.promise, abort: (id: string) => aborted.push(id) } });
  a.hold('native', thread('native', { preview: 'existing' }));
  a.defaults = () => settings.promise;
  const send = a.startTurn('native', { kind: 'codex', id: 'native' }, { text: 'retryable', opts: {} });
  await settle();
  settings.reject(new Error('settings unavailable'));
  assert.equal((await send).started, false);
  assert.deepEqual(aborted, ['native']);
  assert.equal(events.at(-1)!.e.kind, 'turnFailed');
  snapshot.resolve(undefined);
  await settle();
  assert.equal(server.methods().includes('turn/start'), false);
  a.defaults = async () => ({ inputs: {} });
  assert.equal((await a.startTurn('native', { kind: 'codex', id: 'native' }, { text: 'retryable', opts: {} })).started, true);
});

test("a running turn's items reach TurnChanges, so a tool item that beats the baseline voids it", async () => {
  const seen: any[] = [];
  const { a, server } = setup(
    {},
    { turnChanges: { begin: async () => undefined, abort() {}, itemStarted: (id: string, item: any) => seen.push([id, item?.type]) } },
  );
  a.hold('native', thread('native', { preview: 'existing' }));
  assert.equal((await a.startTurn('native', { kind: 'codex', id: 'native' }, { text: 'edit it', opts: {} })).started, true);
  server.notify('item/started', { threadId: 'native', turnId: 'turn-1', item: { type: 'fileChange', id: 'f' } });
  server.notify('item/started', { turnId: 'turn-1', item: { type: 'fileChange', id: 'g' } });
  server.notify('item/completed', { threadId: 'native', turnId: 'turn-1', item: { type: 'fileChange', id: 'f' } });
  assert.deepEqual(seen, [['native', 'fileChange']]);
});
