// User-directed text writes preserve prior contents and owned-file cleanup when persistence fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/files.cjs');
const { writeTextFile } = require('../electron/harness/acp/clientMethods.cjs');

function dialogWriter(file: string, choose = async () => ({ canceled: false, filePath: file }) as any) {
  const handlers = new Map<string, (...args: any[]) => any>();
  register(
    { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
    {
      app: { getPath: () => path.dirname(file) },
      BrowserWindow: { fromWebContents: () => undefined },
      dialog: { showSaveDialog: choose },
      run: async () => ({ ok: true, stdout: '', stderr: '' }),
      live: {},
    },
  );
  return (text: string) => handlers.get('dialog:saveText')!({ sender: {} }, 'out.txt', text);
}

for (const kind of ['dialog', 'acp']) {
  test(`${kind}: a partial write failure preserves the existing file and leaves no temporary data`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-atomic-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'out.txt');
    fs.writeFileSync(file, 'original complete text');
    const write = kind === 'dialog' ? dialogWriter(file) : (content: string) => writeTextFile({ path: file, content });
    const original = fs.writeFileSync;
    const failure = Object.assign(new Error('disk full after a partial write'), { code: 'ENOSPC' });
    const mock = t.mock.method(fs, 'writeFileSync', (target: any, _data: any, options: any) => {
      original(target, 'partial', options);
      throw failure;
    });
    await assert.rejects(
      async () => write('replacement complete text'),
      (error) => error === failure,
    );
    mock.mock.restore();
    assert.equal(fs.readFileSync(file, 'utf8'), 'original complete text');
    assert.deepEqual(fs.readdirSync(dir), ['out.txt']);
    await write('retry complete text');
    assert.equal(fs.readFileSync(file, 'utf8'), 'retry complete text');
  });
}

for (const kind of ['dialog', 'acp']) {
  for (const existing of [false, true]) {
    test(`${kind}: failed replacement ${existing ? 'preserves an existing destination' : 'leaves no new destination'}`, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-rename-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const file = path.join(dir, 'out.txt');
      if (existing) fs.writeFileSync(file, 'old');
      const write = kind === 'dialog' ? dialogWriter(file) : (content: string) => writeTextFile({ path: file, content });
      const failure = Object.assign(new Error('replacement denied'), { code: 'EACCES' });
      t.mock.method(fs, 'renameSync', () => {
        throw failure;
      });
      await assert.rejects(
        async () => write('new'),
        (error) => error === failure,
      );
      assert.deepEqual(fs.readdirSync(dir), existing ? ['out.txt'] : []);
      if (existing) assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    });
  }

  test(`${kind}: successful replacement preserves symlink identity and target access bits`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-link-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'target with "quotes".txt');
    const file = path.join(dir, 'alias.txt');
    fs.writeFileSync(target, 'old');
    fs.chmodSync(target, 0o751);
    fs.symlinkSync(target, file);
    const write = kind === 'dialog' ? dialogWriter(file) : (content: string) => writeTextFile({ path: file, content });
    await write('new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o751);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['alias.txt', 'target with "quotes".txt']);
  });
}

for (const order of [
  [0, 1],
  [1, 0],
]) {
  test(`dialog: independent writes follow dialog completion order ${order.join(',')}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-order-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'out.txt');
    const settle: Array<(result: any) => void> = [];
    const write = dialogWriter(file, () => new Promise((resolve) => settle.push(resolve)));
    const pending = [write('first'), write('second')];
    for (const index of order) {
      settle[index]({ canceled: false, filePath: file });
      assert.equal(await pending[index], file);
      assert.equal(fs.readFileSync(file, 'utf8'), ['first', 'second'][index]);
    }
  });
}

for (const result of [{ canceled: true, filePath: '/unused' }, { canceled: false }]) {
  test(`dialog: no file changes after ${result.canceled ? 'cancellation' : 'missing selection'}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-cancel-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'out.txt');
    const write = dialogWriter(file, async () => result);
    assert.equal(await write('new'), null);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
}

test('dialog: selection failure rejects without creating a destination', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-dialog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const failure = new Error('dialog failed');
  const write = dialogWriter(path.join(dir, 'out.txt'), async () => {
    throw failure;
  });
  await assert.rejects(write('new'), (error) => error === failure);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ACP keeps empty-content conversion and rejects relative paths before writing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'out.txt');
  for (const content of [undefined, null, '', 42]) {
    assert.equal(writeTextFile({ path: file, content }), null);
    assert.equal(fs.readFileSync(file, 'utf8'), String(content ?? ''));
  }
  assert.throws(() => writeTextFile({ path: 'relative.txt', content: 'new' }), /must be absolute/);
});

for (const kind of ['dialog', 'acp']) {
  test(`${kind}: original write error survives failed temporary cleanup`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-cleanup-'));
    const remove = fs.rmSync;
    t.after(() => remove(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'out.txt');
    fs.writeFileSync(file, 'old');
    const write = kind === 'dialog' ? dialogWriter(file) : (content: string) => writeTextFile({ path: file, content });
    const failure = new Error('primary write failure');
    t.mock.method(fs, 'writeFileSync', () => {
      throw failure;
    });
    t.mock.method(fs, 'rmSync', () => {
      throw new Error('cleanup failure');
    });
    await assert.rejects(
      async () => write('new'),
      (error) => error === failure,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  });
}

for (const kind of ['dialog', 'acp', 'platform']) {
  test(`${kind}: denied target write access preserves original bytes through a symlink`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-denied-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const realDirectory = path.join(dir, 'real');
    const aliasDirectory = path.join(dir, 'directory-alias');
    fs.mkdirSync(realDirectory);
    fs.symlinkSync(realDirectory, aliasDirectory, 'dir');
    const target = path.join(aliasDirectory, 'target.txt');
    const file = path.join(dir, 'alias.txt');
    fs.writeFileSync(target, 'old');
    fs.symlinkSync(target, file);
    const failure = Object.assign(new Error('target is read-only'), { code: 'EACCES' });
    // macOS temporary roots and explicit directory aliases may have a different canonical path.
    const canonicalTarget = fs.realpathSync.native(target);
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', (p: any, mode: any) => {
      if (String(p) === canonicalTarget && mode === fs.constants.O_WRONLY) throw failure;
      return open(p, mode);
    });
    if (kind === 'platform') {
      const { writeText } = require('../electron/platform/fs.cjs');
      // the row reads a sentence (#1863)
      assert.deepEqual(writeText(file, 'new'), { ok: false, error: 'Permission denied.' });
    } else {
      const write = kind === 'dialog' ? dialogWriter(file) : (content: string) => writeTextFile({ path: file, content });
      await assert.rejects(
        async () => write('new'),
        (error) => error === failure,
      );
    }
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(dir).sort(), ['alias.txt', 'directory-alias', 'real']);
    assert.deepEqual(fs.readdirSync(realDirectory), ['target.txt']);
  });
}

for (const kind of ['dialog', 'acp']) {
  test(`${kind}: a valid long basename can be replaced atomically`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-long-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'x'.repeat(240));
    fs.writeFileSync(file, 'old');
    const write = kind === 'dialog' ? dialogWriter(file) : (content: string) => writeTextFile({ path: file, content });
    await write('new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(dir), [path.basename(file)]);
  });
}

for (const kind of ['dialog', 'acp']) {
  test(`${kind}: atomic replacement publishes only the selected hard-link name`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-hardlink-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'selected.txt');
    const alias = path.join(dir, 'other-name.txt');
    fs.writeFileSync(file, 'old');
    fs.linkSync(file, alias);
    const write = kind === 'dialog' ? dialogWriter(file) : (content: string) => writeTextFile({ path: file, content });
    await write('new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.equal(fs.readFileSync(alias, 'utf8'), 'old');
    assert.notEqual(fs.statSync(file).ino, fs.statSync(alias).ino);
  });

  test(`${kind}: failed preflight descriptor close stops before replacement`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-close-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'out.txt');
    fs.writeFileSync(file, 'old');
    const write = kind === 'dialog' ? dialogWriter(file) : (content: string) => writeTextFile({ path: file, content });
    const close = fs.closeSync;
    const failure = new Error('close failed');
    const mocked = t.mock.method(fs, 'closeSync', (fd: number) => {
      close(fd);
      throw failure;
    });
    await assert.rejects(
      async () => write('new'),
      (error) => error === failure,
    );
    mocked.mock.restore();
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), ['out.txt']);
  });
}
