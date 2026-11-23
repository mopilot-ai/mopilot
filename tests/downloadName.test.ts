// Browser-tab downloads never overwrite a file: a free name like Chromium's.
import { test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { uniqueDownloadPath, reserveDownloadPath } = createRequire(import.meta.url)('../electron/capabilities/browser/downloadName.cjs');
const dir = path.join(path.sep, 'dl');
const takenOf =
  (...names: string[]) =>
  (p: string) =>
    names.map((n) => path.join(dir, n)).includes(p);

test('a free name is kept', () => {
  assert.equal(uniqueDownloadPath(dir, 'report.pdf', takenOf()), path.join(dir, 'report.pdf'));
});

test('a taken name gets the first free number', () => {
  assert.equal(uniqueDownloadPath(dir, 'report.pdf', takenOf('report.pdf')), path.join(dir, 'report (1).pdf'));
  assert.equal(uniqueDownloadPath(dir, 'report.pdf', takenOf('report.pdf', 'report (1).pdf')), path.join(dir, 'report (2).pdf'));
});

test('no extension, a dotfile, a path in the name, no name', () => {
  assert.equal(uniqueDownloadPath(dir, 'README', takenOf('README')), path.join(dir, 'README (1)'));
  assert.equal(uniqueDownloadPath(dir, '.env', takenOf('.env')), path.join(dir, '.env (1)'));
  assert.equal(uniqueDownloadPath(dir, '../evil.sh', takenOf()), path.join(dir, 'evil.sh'));
  assert.equal(uniqueDownloadPath(dir, '', takenOf()), path.join(dir, 'download'));
});

test('a reserved path is held until its download is done, in any folder', () => {
  const { EventEmitter } = require('node:events');
  const a = new EventEmitter();
  const b = new EventEmitter();
  const file = reserveDownloadPath(dir, 'r.zip', a);
  assert.equal(file, path.join(dir, 'r.zip'));
  assert.equal(reserveDownloadPath(dir, 'r.zip', b), path.join(dir, 'r (1).zip'));
  assert.equal(reserveDownloadPath(path.join(path.sep, 'other'), 'r.zip', new EventEmitter()), path.join(path.sep, 'other', 'r.zip'));
  a.emit('done');
  b.emit('done');
  assert.equal(reserveDownloadPath(dir, 'r.zip', new EventEmitter()), file);
});

test('a compressed archive keeps its double extension, as Chromium does', () => {
  assert.equal(uniqueDownloadPath(dir, 'archive.tar.gz', takenOf('archive.tar.gz')), path.join(dir, 'archive (1).tar.gz'));
  assert.equal(uniqueDownloadPath(dir, 'src.TAR.BZ2', takenOf('src.TAR.BZ2')), path.join(dir, 'src (1).TAR.BZ2'));
  // a long middle part is part of the name, a plain .gz is one extension, and a dotfile's suffix is its own
  assert.equal(uniqueDownloadPath(dir, 'data.backup.gz', takenOf('data.backup.gz')), path.join(dir, 'data.backup (1).gz'));
  assert.equal(uniqueDownloadPath(dir, 'log.gz', takenOf('log.gz')), path.join(dir, 'log (1).gz'));
  assert.equal(uniqueDownloadPath(dir, '.tar.gz', takenOf('.tar.gz')), path.join(dir, '.tar (1).gz'));
  assert.equal(uniqueDownloadPath(dir, 'notes.tar.zip', takenOf('notes.tar.zip')), path.join(dir, 'notes.tar (1).zip'));
});

test('existing directory entries, including dangling symlinks, remain taken', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-download-entry-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const link = path.join(folder, 'report.pdf');
  const target = path.join(folder, 'missing.pdf');
  fs.symlinkSync(target, link);
  fs.writeFileSync(path.join(folder, 'report (1).pdf'), 'keep');
  fs.mkdirSync(path.join(folder, 'report (2).pdf'));
  const item = new EventEmitter();
  const chosen = reserveDownloadPath(folder, 'report.pdf', item);
  t.after(() => item.emit('done'));
  assert.equal(chosen, path.join(folder, 'report (3).pdf'));
  assert.equal(fs.readlinkSync(link), target);
  assert.equal(fs.readFileSync(path.join(folder, 'report (1).pdf'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(target), false);
});

test('an unreadable destination is not reserved as though it were free', (t) => {
  const item = new EventEmitter();
  const denied = Object.assign(new Error('cannot inspect destination'), { code: 'EACCES' });
  const stat = mock.method(fs, 'lstatSync', () => {
    throw denied;
  });
  t.after(() => stat.mock.restore());
  assert.throws(
    () => reserveDownloadPath(dir, 'unreadable.pdf', item),
    (error) => error === denied,
  );
  assert.equal(item.listenerCount('done'), 0);
  stat.mock.restore();
  const chosen = reserveDownloadPath(dir, 'unreadable.pdf', item);
  t.after(() => item.emit('done'));
  assert.equal(chosen, path.join(dir, 'unreadable.pdf'), 'a failed inspection did not consume the name');
});
