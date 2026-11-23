// A chat's rename tells this run's controller the new name at once (#5238): the person's own name from the sidebar and an automatic title alike, so the next notification carries it and not the first words the chat was titled by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renameTitle } = require('../electron/harness/acp/rename.cjs');

function host() {
  const told: any[] = [];
  const written: any[] = [];
  const asked: any[] = [];
  return {
    told,
    written,
    asked,
    now: () => 7,
    titleSessions: { latest: new Map() },
    items: { append: (_k: string, r: object) => written.push(r) },
    emit: (name: string, e: object) => told.push([name, e]),
    remoteRename: (key: string, name: string) => (asked.push([key, name]), Promise.resolve('ok')),
  };
}

test('a name the person gives is written, told to the controller and sent to the machine', async () => {
  const h = host();
  assert.equal(await renameTitle(h, 'acp:host-codex:c1', 'Rain haiku chat', false), 'ok');
  assert.deepEqual(h.written, [{ t: 'title', name: 'Rain haiku chat', at: 7 }]);
  assert.deepEqual(h.told, [['event', { kind: 'threadName', key: 'acp:host-codex:c1', name: 'Rain haiku chat' }]]);
  assert.deepEqual(h.asked, [['acp:host-codex:c1', 'Rain haiku chat']]);
});

test('an automatic title is told too, and a name that is not text tells nothing', () => {
  const h = host();
  assert.equal(renameTitle(h, 'acp:kimi:k1', 'Fix the build', true), null);
  assert.deepEqual(
    h.told.map(([, e]: any) => e.name),
    ['Fix the build'],
  );
  assert.equal(renameTitle(h, 'acp:kimi:k1', 42, false), null);
  assert.equal(h.told.length, 1);
});
