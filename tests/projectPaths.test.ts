// Filesystem project identities cover symlinks, literal filenames, missing folders and the actual IPC boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import '../src/lib/native/projects.ts';

const require = createRequire(import.meta.url);
const { canonicalPaths } = require('../electron/platform/projectPaths.cjs');
const { ProjectsStore, registerProjects } = require('../electron/platform/projects.cjs');
const { buildApi } = require('../electron/bridge/spec.cjs');
const bridge = require('../electron/bridge/projects.cjs');

test('canonical folder IPC resolves symlinks and literal punctuation without writing project state', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'Projects', "a 'quote' # with spaces");
  const alias = path.join(dir, 'alias');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, alias, 'junction');
  const file = path.join(dir, 'projects.json');
  const handlers = new Map<string, Function>();
  registerProjects({ handle: (name: string, fn: Function) => handlers.set(name, fn) }, new ProjectsStore(file));
  const api = buildApi(bridge, {
    ipcRenderer: { invoke: (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args) },
    webUtils: {},
  });
  const expected = fs.realpathSync(real);
  assert.deepEqual(await api.canonicalPaths([alias, real, alias]), { [alias]: expected, [real]: expected });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await canonicalPaths([]), {});
});

test('missing paths and paths beneath a file retain their lexical identity', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'file');
  fs.writeFileSync(file, 'fixture');
  const missing = path.join(dir, 'missing');
  const notDirectory = path.join(file, 'nested');
  assert.deepEqual(await canonicalPaths([missing, notDirectory]), { [missing]: missing, [notDirectory]: notDirectory });
});

test('invalid batches reject before reading the filesystem', async (t) => {
  const read = t.mock.method(promises, 'realpath', async () => '/unused');
  for (const input of [null, {}, 'folder', [null], [1], ['relative'], ['']]) await assert.rejects(canonicalPaths(input), /absolute paths/);
  assert.equal(read.mock.callCount(), 0);
});

test('unexpected filesystem failures reject rather than falsely equating directories', async (t) => {
  t.mock.method(promises, 'realpath', async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  await assert.rejects(canonicalPaths([path.resolve('/private-folder')]), /denied/);
});
