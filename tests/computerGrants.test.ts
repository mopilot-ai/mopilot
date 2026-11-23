// The computer-use grant store (electron/capabilities/grants.cjs): "Allow in this chat" in the chat's
// meta, "Always allow" (the remembered apps every chat gets without a card) and the user's deny list in
// userData/capabilities/computer.json. Covers add, remove, Remove all, persistence, and a corrupt file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { GrantStore, withGrant, cleanRungs } = require('../electron/capabilities/grants.cjs');

const TEXTEDIT = { bundleId: 'com.apple.TextEdit', name: 'TextEdit' };
const NOTES = { bundleId: 'com.apple.Notes', name: 'Notes' };

function fakeChats(ok = true) {
  const meta = new Map<string, any>();
  return {
    meta,
    get: (id: string) => (meta.has(id) ? { meta: meta.get(id) } : null),
    patchMeta: (id: string, patch: any) => {
      if (!ok) return false;
      meta.set(id, { ...(meta.get(id) ?? {}), ...patch });
      return true;
    },
  };
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-grant-store-'));
  return { dir, file: path.join(dir, 'capabilities', 'computer.json') };
}

test('always allow: added, raised but never lowered, persisted, removed one by one and all at once', () => {
  const { dir, file } = tmpFile();
  try {
    const changed: (string | null)[] = [];
    let now = 10;
    const g = new GrantStore({ file, chats: fakeChats(), onChange: (c: string | null) => changed.push(c), now: () => now });
    assert.deepEqual(g.global(), []);
    assert.equal(g.clearGlobal(), false, 'nothing to remove');
    assert.deepEqual(changed, []);
    assert.equal(g.grant(null, TEXTEDIT, 'full', 'always'), true);
    now = 20;
    assert.equal(g.grant('c1', NOTES, 'click', 'always'), true, 'the chat does not matter for Always allow');
    // a weaker remembered grant does not lower a stronger one
    g.grant(null, { bundleId: 'com.apple.textedit' }, 'view', 'always');
    assert.deepEqual(g.global(), [
      { bundleId: 'com.apple.Notes', name: 'Notes', level: 'click', at: 20 },
      { bundleId: 'com.apple.textedit', name: 'com.apple.textedit', level: 'full', at: 20 },
    ]);
    // every chat gets the remembered apps
    assert.deepEqual(
      g.forChat('any').map((x: any) => x.bundleId),
      ['com.apple.Notes', 'com.apple.textedit'],
    );
    // global() is a copy
    g.global().pop();
    assert.equal(g.global().length, 2);
    // it survives a restart
    const again = new GrantStore({ file, chats: fakeChats() });
    assert.deepEqual(
      again.global().map((x: any) => [x.bundleId, x.level]),
      [
        ['com.apple.Notes', 'click'],
        ['com.apple.textedit', 'full'],
      ],
    );
    // Remove: one app, case-insensitively; an app that is not there changes nothing
    assert.equal(g.revoke(null, 'COM.APPLE.NOTES'), true);
    assert.equal(g.revoke(null, 'com.example.none'), false);
    assert.deepEqual(
      g.global().map((x: any) => x.bundleId),
      ['com.apple.textedit'],
    );
    // Remove all
    g.grant(null, NOTES, 'full', 'always');
    assert.equal(g.clearGlobal(), true);
    assert.deepEqual(g.global(), []);
    assert.deepEqual(new GrantStore({ file, chats: fakeChats() }).global(), [], 'the empty list is saved');
    assert.deepEqual(changed, [null, null, null, null, null, null]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Remove all leaves the chats' own grants and the deny list alone", () => {
  const { dir, file } = tmpFile();
  try {
    const chats = fakeChats();
    const g = new GrantStore({ file, chats });
    g.grant('c1', NOTES, 'full', 'chat');
    g.grant(null, TEXTEDIT, 'full', 'always');
    g.setDeny(['com.example.bank']);
    g.clearGlobal();
    assert.deepEqual(
      g.forChat('c1').map((x: any) => x.bundleId),
      ['com.apple.Notes'],
    );
    assert.deepEqual(g.deny(), ['com.example.bank']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt or odd file loads as empty lists; bad entries are dropped', () => {
  const { dir, file } = tmpFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(new GrantStore({ file, chats: fakeChats() }).global(), []);
    fs.writeFileSync(file, 'null');
    const n = new GrantStore({ file, chats: fakeChats() });
    assert.deepEqual([n.global(), n.deny()], [[], []]);
    fs.writeFileSync(file, JSON.stringify({ global: 'TextEdit', deny: { a: 1 } }));
    const odd = new GrantStore({ file, chats: fakeChats() });
    assert.deepEqual([odd.global(), odd.deny()], [[], []]);
    fs.writeFileSync(
      file,
      JSON.stringify({
        global: [
          null,
          { bundleId: '', level: 'full' },
          { bundleId: 'x', level: 'root' },
          { bundleId: 7, level: 'full' },
          { bundleId: 'com.apple.TextEdit', name: '', level: 'full', at: 'soon' },
        ],
        deny: ['', 3, 'com.example.bank'],
      }),
    );
    const mixed = new GrantStore({ file, chats: fakeChats() });
    assert.deepEqual(mixed.global(), [{ bundleId: 'com.apple.TextEdit', name: 'com.apple.TextEdit', level: 'full', at: 0 }]);
    assert.deepEqual(mixed.deny(), ['com.example.bank']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that cannot be written rejects the change and preserves memory', () => {
  const { dir } = tmpFile();
  try {
    // The loaded store becomes unwritable: no change may be reported as saved.
    const file = path.join(dir, 'taken');
    const g = new GrantStore({ file, chats: fakeChats() });
    fs.mkdirSync(file);
    assert.throws(() => g.grant(null, TEXTEDIT, 'full', 'always'), { code: 'save_failed' });
    assert.deepEqual(g.global(), []);
    assert.equal(g.clearGlobal(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a grant needs an app, a level and a scope that keeps something; chat grants follow the chat store', () => {
  const { dir, file } = tmpFile();
  try {
    const g = new GrantStore({ file, chats: fakeChats() });
    assert.equal(g.grant('c1', null, 'full', 'always'), false);
    assert.equal(g.grant('c1', { bundleId: '' }, 'full', 'always'), false);
    assert.equal(g.grant('c1', TEXTEDIT, 'root', 'always'), false);
    assert.equal(g.grant('c1', TEXTEDIT, 'full', 'once'), false);
    assert.equal(g.grant(null, TEXTEDIT, 'full', 'chat'), false, 'a chat grant needs a chat');
    assert.deepEqual(g.global(), []);
    assert.equal(g.grant('c1', TEXTEDIT, 'full', 'chat'), true);
    assert.deepEqual(
      g.chat('c1').map((x: any) => x.bundleId),
      ['com.apple.TextEdit'],
    );
    assert.deepEqual(g.chat('c2'), [], 'a chat without grants');
    assert.equal(g.revoke('c1', 'com.apple.TextEdit'), true);
    assert.deepEqual(g.chat('c1'), []);
    // a chat store that refuses the patch
    const no = new GrantStore({ file, chats: fakeChats(false) });
    assert.equal(no.grant('c1', TEXTEDIT, 'full', 'chat'), false);
    assert.equal(no.revoke('c1', 'com.apple.TextEdit'), false);
    // setDeny takes only a list, trimmed and deduplicated
    assert.deepEqual(no.setDeny('com.example.bank'), []);
    assert.deepEqual(no.setDeny([' com.example.bank ', 'com.example.bank', '']), ['com.example.bank']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withGrant: a missing list starts empty; null removes the app', () => {
  assert.deepEqual(withGrant(undefined, TEXTEDIT, 'click', 1), [
    { bundleId: 'com.apple.TextEdit', name: 'TextEdit', level: 'click', at: 1 },
  ]);
  assert.deepEqual(withGrant([{ bundleId: 'com.apple.TextEdit', level: 'click' }], TEXTEDIT, null, 0), []);
});

test('brief switching: on by default, saved; the rung that worked is remembered per app and survives a reload', () => {
  const { dir, file } = tmpFile();
  try {
    const changed: (string | null)[] = [];
    const g = new GrantStore({ file, chats: fakeChats(), onChange: (c: string | null) => changed.push(c), now: () => 7 });
    assert.equal(g.briefForeground(), true);
    assert.equal(g.setBriefForeground(false), false);
    assert.deepEqual(changed, [null]);
    assert.equal(g.rung('com.apple.textedit', 'type'), 'background');
    assert.equal(g.rememberRung(TEXTEDIT, 'type', 'foreground'), true);
    assert.equal(g.rememberRung(TEXTEDIT, 'type', 'foreground'), false, 'unchanged');
    assert.equal(g.rememberRung(TEXTEDIT, 'key', 'sideways'), false, 'not a rung');
    assert.equal(g.rememberRung(null, 'key', 'foreground'), false);
    assert.equal(g.rememberRung({ bundleId: 'com.x' }, 'click', 'foreground'), true);
    assert.equal(g.rememberRung({ bundleId: 'com.x' }, 'key', 'foreground'), true, 'a second action of a remembered app');
    assert.equal(g.rung('com.x', 'key'), 'foreground');
    assert.equal(g.rung('COM.APPLE.TEXTEDIT', 'type'), 'foreground');
    assert.equal(g.rung(undefined, 'type'), 'background');
    const again = new GrantStore({ file, chats: fakeChats() });
    assert.equal(again.briefForeground(), false);
    assert.equal(again.rung('com.apple.TextEdit', 'type'), 'foreground');
    assert.equal(again.rung('com.x', 'click'), 'foreground');
    assert.equal(again.setBriefForeground(true), true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.rungs['com.apple.textedit'], { name: 'TextEdit', actions: { type: 'foreground' }, at: 7 });
    assert.equal(saved.rungs['com.x'].name, 'com.x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanRungs drops junk; a rung that cannot be saved is kept in memory', () => {
  assert.deepEqual(cleanRungs(null), {});
  assert.deepEqual(cleanRungs([]), {});
  assert.deepEqual(
    cleanRungs({
      '': { actions: { type: 'foreground' } },
      a: null,
      b: { actions: null },
      c: { actions: { type: 'nope' } },
      'D.App': { name: 'D', actions: { type: 'foreground', key: 'x' }, at: 'z' },
      e: { name: '', actions: { click: 'background' }, at: 3 },
    }),
    { 'd.app': { name: 'D', actions: { type: 'foreground' }, at: 0 }, e: { name: 'e', actions: { click: 'background' }, at: 3 } },
  );
  const { dir } = tmpFile();
  try {
    const file = path.join(dir, 'taken');
    const g = new GrantStore({ file, chats: fakeChats() });
    fs.mkdirSync(file);
    assert.equal(g.rememberRung(NOTES, 'type', 'foreground'), true);
    assert.equal(g.rung(NOTES.bundleId, 'type'), 'foreground');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('permission recovery preserves its prior store before new grants replace defaults', (t) => {
  const { dir, file } = tmpFile();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = '{"deny":["bank"],"global":[';
  fs.writeFileSync(file, original);
  const store = new GrantStore({ file, chats: fakeChats() });
  assert.throws(() => store.grant(null, TEXTEDIT, 'full', 'always'), { code: 'save_failed' });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), original);
});
