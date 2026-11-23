// Generic renderer preference deletion cannot coerce malformed keys into main-owned consent or MoMo fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { ChatsStore, registerChats, patchPrefsSync, flushPendingWrites } = createRequire(import.meta.url)('../electron/platform/chats.cjs');

for (const key of ['mobileRemoteOwner', 'momo']) {
  test(`nested renderer deletion cannot remove main-owned ${key}`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-owned-pref-'));
    const file = path.join(dir, 'state.json');
    t.after(() => {
      flushPendingWrites();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const initial = { mobileRemoteOwner: 'owner', momo: { paused: true }, theme: 'light' };
    patchPrefsSync(file, initial);
    const handlers = new Map<string, Function>();
    const sent: unknown[] = [];
    registerChats(
      { handle: (name: string, fn: Function) => handlers.set(name, fn) },
      {
        store: new ChatsStore(path.join(dir, 'threads'), { uiState: file }),
        uiState: file,
        broadcast: (...args: unknown[]) => sent.push(args),
      },
    );
    const patch = handlers.get('prefs:patch')!;
    for (const malformed of [[key], [[key]], {}, null, 1]) {
      assert.equal(patch({ sender: 'window' }, { theme: 'dark' }, [malformed]), false);
      flushPendingWrites();
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).prefs, initial);
      assert.equal(sent.length, 0);
    }
    assert.equal(patch({ sender: 'window' }, { theme: 'dark' }, []), true);
  });
}
