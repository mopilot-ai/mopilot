// Chat file schemas establish write ownership across harnesses without trusting foreign record ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const chats = require('../electron/platform/chats.cjs');
const { ChatsStore } = chats;

import { tmp } from './support/chat-store-profile.ts';

for (const version of [undefined, null, 0, -1, 1.5, 2.5, '2', 'future', true, {}, []]) {
  test(`chat writes preserve unowned schema ${JSON.stringify(version)} on every harness`, (t) => {
    const { threads } = tmp(t);
    const ids = ['codex-invalid', 'claude:invalid', 'acp:test:invalid'];
    const originals = new Map<string, string>();
    for (const id of ids) {
      const original = JSON.stringify({ id, schemaVersion: version, segments: [{ kind: 'codex', nativeId: id }], private: 'foreign' });
      originals.set(id, original);
      fs.writeFileSync(path.join(threads, encodeURIComponent(id) + '.v2'), original);
    }
    const store = new ChatsStore(threads, { legacyMirror: false });
    assert.deepEqual(store.snapshot().chats, {});
    for (const id of ids) {
      assert.equal(store.ensure(id), false);
      assert.equal(store.patchMeta(id, { pinned: true }), false);
      assert.equal(store.setSegments(id, [{ harness: 'codex', nativeId: 'changed' }]), false);
      assert.equal(fs.readFileSync(store.file(id), 'utf8'), originals.get(id));
    }
  });
}

test('valid older and current chat schemas remain writable, and future schemas remain readable but protected', (t) => {
  const { threads } = tmp(t);
  for (const version of [1, 2, 3]) {
    const id = `version-${version}`;
    fs.writeFileSync(
      path.join(threads, `${id}.v2`),
      JSON.stringify({ id, schemaVersion: version, segments: [{ kind: 'codex', nativeId: id }] }),
    );
  }
  const store = new ChatsStore(threads, { legacyMirror: false });
  assert.deepEqual(Object.keys(store.snapshot().chats), ['version-1', 'version-2', 'version-3']);
  assert.deepEqual(store.snapshot().newer, ['version-3']);
  for (const version of [1, 2]) {
    assert.equal(store.patchMeta(`version-${version}`, { pinned: true }), true);
    assert.equal(JSON.parse(fs.readFileSync(store.file(`version-${version}`), 'utf8')).schemaVersion, 2);
  }
  assert.equal(store.patchMeta('version-3', { pinned: true }), false);
  assert.equal(JSON.parse(fs.readFileSync(store.file('version-3'), 'utf8')).schemaVersion, 3);
});

test('foreign record bodies protect their canonical file owner without freezing the claimed chat', (t) => {
  const { threads } = tmp(t);
  fs.writeFileSync(
    path.join(threads, 'claimed.v2'),
    JSON.stringify({ id: 'claimed', schemaVersion: 2, segments: [{ kind: 'codex', nativeId: 'real' }] }),
  );
  const ids = ['codex-owner', 'claude:owner', 'acp:test:owner'];
  const originals = new Map<string, string>();
  for (const id of ids) {
    const original = JSON.stringify({ id: 'claimed', schemaVersion: 999, segments: [{ kind: 'claude', nativeId: 'foreign' }] });
    originals.set(id, original);
    fs.writeFileSync(path.join(threads, encodeURIComponent(id) + '.v2'), original);
  }
  const store = new ChatsStore(threads, { legacyMirror: false });
  assert.equal(store.patchMeta('claimed', { pinned: true }), true);
  assert.deepEqual(store.snapshot().newer, []);
  for (const id of ids) {
    assert.equal(store.ensure(id), false);
    assert.equal(store.patchMeta(id, { pinned: true }), false);
    assert.equal(store.setSegments(id, [{ harness: 'codex', nativeId: 'changed' }]), false);
    assert.equal(fs.readFileSync(store.file(id), 'utf8'), originals.get(id));
  }
});

test('an unreadable alias filename cannot freeze the canonical chat it decodes to', (t) => {
  const { threads } = tmp(t);
  const alias = path.join(threads, '%63odex.v2');
  fs.writeFileSync(alias, '{ torn');
  fs.writeFileSync(
    path.join(threads, 'codex.v2'),
    JSON.stringify({ id: 'codex', schemaVersion: 2, segments: [{ kind: 'codex', nativeId: 'codex' }] }),
  );
  const store = new ChatsStore(threads, { legacyMirror: false });
  assert.equal(store.patchMeta('codex', { pinned: true }), true);
  assert.equal(fs.readFileSync(alias, 'utf8'), '{ torn');
});
