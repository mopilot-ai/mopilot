// Read-only local folder availability distinguishes inaccessible directories from undecided filesystem reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { folderAvailability } = require('../electron/platform/projectPaths.cjs');
const { ProjectsStore, registerProjects } = require('../electron/platform/projects.cjs');
const { buildApi } = require('../electron/bridge/spec.cjs');
const bridge = require('../electron/bridge/projects.cjs');
const { chatFolderGuard, missingFolderError } = require('../electron/session/chatFolderGuard.cjs');

test('the real IPC checks directories and aliases without changing projects, and observes deletion and restoration', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-folder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'ccprobe', 'work');
  const alias = path.join(root, 'alias');
  const file = path.join(root, 'file');
  fs.mkdirSync(folder, { recursive: true });
  fs.symlinkSync(folder, alias, 'junction');
  fs.writeFileSync(file, 'preserve me');
  const storeFile = path.join(root, 'projects.json');
  const store = new ProjectsStore(storeFile);
  store.add({ path: folder, name: 'work' });
  const saved = fs.readFileSync(storeFile, 'utf8');
  const handlers = new Map<string, Function>();
  registerProjects({ handle: (key: string, fn: Function) => handlers.set(key, fn) }, store);
  const api = buildApi(bridge, {
    ipcRenderer: { invoke: (key: string, ...args: unknown[]) => handlers.get(key)!({}, ...args) },
    webUtils: {},
  });
  assert.deepEqual(await api.folderAvailability([folder, alias, file, folder]), { [folder]: true, [alias]: true, [file]: false });
  fs.rmdirSync(folder);
  assert.deepEqual(await api.folderAvailability([folder, alias, path.join(file, 'child')]), {
    [folder]: false,
    [alias]: false,
    [path.join(file, 'child')]: false,
  });
  // The original send failure still protects old chats; inspecting the sidebar never starts recovery.
  const guard = chatFolderGuard({ chatProject: async () => folder, state: () => ({}) });
  await assert.rejects(guard({ chatId: 'chat' }), { message: missingFolderError(folder) });
  fs.mkdirSync(folder);
  assert.deepEqual(await api.folderAvailability([folder, alias]), { [folder]: true, [alias]: true });
  await guard({ chatId: 'chat' });
  assert.equal(fs.readFileSync(storeFile, 'utf8'), saved);
  assert.equal(fs.readFileSync(file, 'utf8'), 'preserve me');
  assert.deepEqual(await folderAvailability([]), {});
});

test('permission refusal and disappearance during access hide a folder; transient and unknown errors remain undecided', async (t) => {
  t.mock.method(fs.promises, 'stat', async () => ({ isDirectory: () => true }) as any);
  const access = t.mock.method(fs.promises, 'access', async (_p, mode) => {
    assert.equal(mode, fs.constants.R_OK | fs.constants.X_OK);
  });
  const p = path.resolve('/folder');
  assert.deepEqual(await folderAvailability([p]), { [p]: true });
  for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'EMFILE', undefined]) {
    access.mock.mockImplementation(async () => {
      throw Object.assign(new Error('read failed'), { code });
    });
    assert.deepEqual(await folderAvailability([p]), { [p]: ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code!) ? false : null });
  }
  t.mock.method(fs.promises, 'stat', async () => {
    throw Object.assign(new Error('denied metadata'), { code: 'EACCES' });
  });
  assert.deepEqual(await folderAvailability([p]), { [p]: false });
});

test('invalid local folder batches reject before touching the filesystem', async (t) => {
  const stat = t.mock.method(fs.promises, 'stat', async () => {
    throw new Error('must not read');
  });
  for (const input of [null, {}, '/folder', [null], [1], ['relative'], ['']])
    await assert.rejects(folderAvailability(input), /absolute paths/);
  assert.equal(stat.mock.callCount(), 0);
});

for (const silent of ['stat', 'access'] as const)
  test(`a silent ${silent} cannot hold a missing sibling or accumulate repeated reads`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const slow = path.resolve('/silent');
    const gone = path.resolve('/private/tmp/ccprobe/work');
    let release!: (value: any) => void;
    const waiting = new Promise<any>((resolve) => {
      release = resolve;
    });
    const stat = t.mock.method(fs.promises, 'stat', async (p) => {
      if (p === gone) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return silent === 'stat' ? waiting : { isDirectory: () => true };
    });
    const access = t.mock.method(fs.promises, 'access', async () => {
      if (silent === 'access') await waiting;
    });
    let result: any;
    const read = folderAvailability([slow, gone]).then((v: any) => {
      result = v;
    });
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(2000);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(result, { [slow]: null, [gone]: false });
    assert.deepEqual(await folderAvailability([slow]), { [slow]: null });
    assert.equal(stat.mock.calls.filter((call) => call.arguments[0] === slow).length, 1);
    assert.equal(access.mock.callCount(), silent === 'access' ? 1 : 0);
    release({ isDirectory: () => true });
    await read;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await folderAvailability([slow]), { [slow]: true });
  });
