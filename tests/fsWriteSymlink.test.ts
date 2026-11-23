// Instruction-file writes preserve dangling symlinks and report path-resolution failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { writeText } = createRequire(import.meta.url)('../electron/platform/fs.cjs');
const missing = () => Object.assign(new Error('missing target'), { code: 'ENOENT' });

function captureWrites(t: any) {
  const writes: string[] = [];
  t.mock.method(fs, 'mkdirSync', () => undefined);
  t.mock.method(fs, 'writeFileSync', () => undefined);
  t.mock.method(fs, 'renameSync', (_from: string, target: string) => {
    writes.push(target);
  });
  return writes;
}

test('relative, absolute and chained dangling links write the missing target without replacing a link', (t) => {
  const writes = captureWrites(t);
  t.mock.method(fs.realpathSync, 'native', () => {
    throw missing();
  });
  const links = new Map([
    ['/config/AGENTS.md', '../shared/CLAUDE.md'],
    ['/shared/CLAUDE.md', '/missing/config.txt'],
  ]);
  t.mock.method(fs, 'readlinkSync', (file: string) => {
    if (!links.has(file)) throw missing();
    return links.get(file)!;
  });
  assert.deepEqual(writeText('/config/AGENTS.md', 'instructions'), { ok: true });
  assert.deepEqual(writes, ['/missing/config.txt']);
});

test('path-resolution and link-read errors stop before any write', (t) => {
  const writes = captureWrites(t);
  const realpath = t.mock.method(fs.realpathSync, 'native', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  const readlink = t.mock.method(fs, 'readlinkSync', () => {
    throw Object.assign(new Error('readlink denied'), { code: 'EACCES' });
  });
  assert.deepEqual(writeText('/config/AGENTS.md', 'instructions'), { ok: false, error: 'Permission denied.' });
  realpath.mock.mockImplementation(() => {
    throw missing();
  });
  assert.deepEqual(writeText('/config/AGENTS.md', 'instructions'), { ok: false, error: 'Permission denied.' });
  readlink.mock.mockImplementation(() => {
    throw 'unavailable';
  });
  assert.deepEqual(writeText('/config/AGENTS.md', 'instructions'), { ok: false, error: 'Unavailable.' });
  assert.deepEqual(writes, []);
});

test('cyclic unresolved links are rejected rather than overwritten', (t) => {
  const writes = captureWrites(t);
  t.mock.method(fs.realpathSync, 'native', () => {
    throw missing();
  });
  t.mock.method(fs, 'readlinkSync', () => 'AGENTS.md');
  assert.deepEqual(writeText('/config/AGENTS.md', 'instructions'), { ok: false, error: 'Symbolic link cycle.' });
  assert.deepEqual(writes, []);
});

for (const absolute of [false, true]) {
  test(`instruction writes create missing targets below ${absolute ? 'absolute' : 'relative'} directory symlinks`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-link-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'missing', 'dotfiles');
    const link = path.join(dir, 'config');
    fs.symlinkSync(absolute ? target : path.relative(dir, target), link, 'dir');
    const file = path.join(link, 'nested', 'AGENTS.md');
    assert.deepEqual(writeText(file, 'instructions'), { ok: true });
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(target, 'nested', 'AGENTS.md'), 'utf8'), 'instructions');
  });
}

test('file and directory symlink chains preserve every link while creating the final target', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-chain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'folder');
  const alias = path.join(dir, 'alias');
  fs.symlinkSync('missing/dotfiles', folder, 'dir');
  fs.symlinkSync('folder', alias, 'dir');
  const file = path.join(dir, 'CLAUDE.md');
  fs.symlinkSync('alias/config/CLAUDE.md', file);
  assert.deepEqual(writeText(file, 'shared instructions'), { ok: true });
  for (const link of [folder, alias, file]) assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, 'missing/dotfiles/config/CLAUDE.md'), 'utf8'), 'shared instructions');
});

test('a cycle in an ancestor directory is reported without replacing links or writing files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-cycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync('b', path.join(dir, 'a'), 'dir');
  fs.symlinkSync('a', path.join(dir, 'b'), 'dir');
  const result = writeText(path.join(dir, 'a', 'AGENTS.md'), 'instructions');
  assert.equal(result.ok, false);
  assert.match(result.error, /^(Too many symbolic links encountered|Symbolic link cycle)\.$/);
  assert.ok(fs.lstatSync(path.join(dir, 'a')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(dir, 'b')).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a', 'b']);
});

test('dangling file targets resolve dot segments after following an existing directory symlink', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-dot-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'nested', 'real'), { recursive: true });
  fs.symlinkSync('nested/real', path.join(dir, 'alias'), 'dir');
  const file = path.join(dir, 'AGENTS.md');
  fs.symlinkSync('alias/../target.md', file);
  assert.deepEqual(writeText(file, 'instructions'), { ok: true });
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.equal(fs.readFileSync(file, 'utf8'), 'instructions');
  assert.equal(fs.readFileSync(path.join(dir, 'nested', 'target.md'), 'utf8'), 'instructions');
  assert.equal(fs.existsSync(path.join(dir, 'target.md')), false);
});

test('a missing instruction path containing dot segments follows directory links first', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-path-dots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'nested', 'real'), { recursive: true });
  fs.symlinkSync('nested/real', path.join(dir, 'alias'), 'dir');
  assert.deepEqual(writeText(`${dir}/alias/../AGENTS.md`, 'instructions'), { ok: true });
  assert.equal(fs.readFileSync(path.join(dir, 'nested', 'AGENTS.md'), 'utf8'), 'instructions');
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
});

test('normalizing an unresolved parent cannot overwrite a link that points back to itself', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-normalized-cycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'AGENTS.md');
  fs.symlinkSync('missing/../AGENTS.md', file);
  const result = writeText(file, 'instructions');
  assert.equal(result.ok, false);
  assert.match(result.error, /ELOOP|Symbolic link cycle/);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(dir), ['AGENTS.md']);
});

for (const linked of [false, true]) {
  test(`a missing directory before '..' is created for a ${linked ? 'symlink target' : 'direct instruction path'}`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-missing-dot-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = `${dir}/missing/../target.md`;
    const input = linked ? path.join(dir, 'AGENTS.md') : target;
    if (linked) fs.symlinkSync('missing/../target.md', input);
    assert.deepEqual(writeText(input, 'instructions'), { ok: true });
    assert.equal(fs.readFileSync(input, 'utf8'), 'instructions');
    assert.ok(fs.statSync(path.join(dir, 'missing')).isDirectory());
    assert.equal(fs.readFileSync(path.join(dir, 'target.md'), 'utf8'), 'instructions');
    if (linked) assert.ok(fs.lstatSync(input).isSymbolicLink());
  });
}

test('failure to create a required dot-segment directory stops before the atomic replacement', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-dot-denied-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'AGENTS.md');
  fs.symlinkSync('missing/../target.md', file);
  const write = t.mock.method(fs, 'writeFileSync', () => undefined);
  t.mock.method(fs, 'mkdirSync', () => {
    throw new Error('permission denied');
  });
  assert.deepEqual(writeText(file, 'instructions'), { ok: false, error: 'Permission denied.' });
  assert.equal(write.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(dir), ['AGENTS.md']);
});
