// Saved account registries reject unusable collection shapes without losing the original file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Accounts } = require('../electron/identity/codexAccounts.cjs');
const { ClaudeAccounts } = require('../electron/harness/claude/accounts.cjs');

function store(t: any, kind: string, data: unknown) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-shape-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex');
  fs.mkdirSync(process.env.CODEX_HOME);
  let instance: any;
  t.after(() => {
    instance?.dispose?.();
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, kind === 'codex' ? 'accounts.json' : 'claude-accounts.json');
  const text = JSON.stringify(data);
  fs.writeFileSync(file, text);
  const create = () => {
    instance =
      kind === 'codex'
        ? new Accounts({ userData: root, server: { intercepts: new Set(), listeners: new Set() }, broadcast: () => {} })
        : new ClaudeAccounts({ userData: root, broadcast: () => {}, run: async () => '{}' });
    return instance;
  };
  return { file, text, create };
}

for (const kind of ['codex', 'claude']) {
  for (const [name, data] of [
    ['null collection', { accounts: null }],
    ['object collection', { accounts: {} }],
    ['string collection', { accounts: 'not a list' }],
    ['null entry', { accounts: [null] }],
    ['primitive entry', { accounts: [1] }],
    ['array entry', { accounts: [[]] }],
    ['missing id', { accounts: [{}] }],
    ['numeric id', { accounts: [{ id: 1 }] }],
    ['empty id', { accounts: [{ id: '' }] }],
    ['null root', null],
    ['array root', []],
    ['string root', 'not a registry'],
  ] as const) {
    test(`${kind}: ${name} is preserved before defaults replace it`, (t) => {
      const { create, file, text } = store(t, kind, data);
      const manager = create();
      assert.deepEqual(manager.state.accounts, []);
      assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), text);
      manager.save();
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).accounts, []);
      assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), text);
    });
  }
}

for (const kind of ['codex', 'claude']) {
  test(`${kind}: legacy partial state without accounts retains its preferences`, (t) => {
    const { create, file } = store(t, kind, { autoSwitch: false });
    const manager = create();
    assert.equal(manager.state.autoSwitch, false);
    assert.deepEqual(manager.state.accounts, []);
    assert.equal(fs.existsSync(`${file}.unreadable`), false);
  });

  test(`${kind}: usable records retain their active selection and unknown metadata`, (t) => {
    const account = { id: 'kept', email: 'made-up@example.com', loggedIn: true, metadata: { future: 'retained' } };
    const { create, file } = store(t, kind, { active: 'kept', autoSwitch: false, accounts: [account] });
    const manager = create();
    // a Claude record saved before configDir is adopted at its folder (identity/contract/accountDirs.cjs)
    const kept =
      kind === 'claude' ? { ...account, configDir: path.join(path.dirname(file), 'claude-accounts', 'kept'), unconfirmed: true } : account;
    assert.equal(manager.state.active, 'kept');
    assert.equal(manager.state.autoSwitch, false);
    assert.deepEqual(manager.state.accounts, [kept]);
    assert.equal(fs.existsSync(`${file}.unreadable`), false);
    manager.save();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).accounts, [kept]);
  });

  test(`${kind}: a structural failure retains the oldest recovery copy`, (t) => {
    const { create, file } = store(t, kind, { accounts: [null] });
    fs.writeFileSync(`${file}.unreadable`, 'older recovery data');
    const manager = create();
    manager.save();
    assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), 'older recovery data');
  });
}

for (const kind of ['codex', 'claude']) {
  for (const id of ['.', '..', '../outside', '..\\outside', '/absolute']) {
    test(`${kind}: account id ${JSON.stringify(id)} cannot escape its registry folder`, (t) => {
      const { create, file, text } = store(t, kind, { accounts: [{ id, email: 'made-up@example.com', loggedIn: true }] });
      const manager = create();
      assert.deepEqual(manager.state.accounts, []);
      assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), text);
    });

    test(`${kind}: direct folder lookup rejects account id ${JSON.stringify(id)}`, (t) => {
      const { create } = store(t, kind, { accounts: [] });
      const manager = create();
      assert.throws(() => (kind === 'codex' ? manager.home({ id }) : manager.dir(id)), /Invalid account id/);
    });
  }
}

test('Claude removal rejects traversal before changing state or starting logout', (t) => {
  const { create } = store(t, 'claude', { accounts: [] });
  const manager = create();
  let logouts = 0;
  manager.run = async () => {
    logouts++;
  };
  assert.throws(() => manager.remove('fake-cli', '../outside'), /Invalid account id/);
  assert.equal(logouts, 0);
  assert.deepEqual(manager.state.accounts, []);
});

for (const kind of ['codex', 'claude']) {
  test(`${kind}: ordinary account names, including dot prefixes, remain valid folder names`, (t) => {
    const { create } = store(t, kind, { accounts: [] });
    const manager = create();
    for (const id of ['ordinary', '.hidden', '..named', 'name with spaces']) {
      const folder = kind === 'codex' ? manager.home({ id }) : manager.dir(id);
      assert.equal(folder, path.join(manager.root, id));
      assert.equal(path.dirname(folder), manager.root);
    }
  });
}
