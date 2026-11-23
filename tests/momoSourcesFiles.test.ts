// MoMo's Files source (#2139 P2, electron/momo/sources/files.cjs): folders only inside home (never home, ~/Library or hidden), listing and reading only inside an added folder (symbolic links resolved, hidden names refused and left out), size-bounded text reads, binaries refused, and every read decided and audited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hubFixture, scratch } from './support/momo-sources.ts';

const require = createRequire(import.meta.url);
const { SourceError } = require('../electron/momo/sources/hub.cjs');
const { filesSource, wholeChars, MAX_ENTRIES, MAX_READ, DEFAULT_READ } = require('../electron/momo/sources/files.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const codeOf = (code: string) => (e: any) => e instanceof SourceError && e.code === code;

/** A home with Documents/Work (two files, a hidden one, a sub-folder, a link out), Library, .secret and a folder outside home. */
function setup() {
  const f = hubFixture();
  const home = scratch('momo-home-');
  const outside = scratch('momo-outside-');
  const work = path.join(home, 'Documents', 'Work');
  fs.mkdirSync(path.join(work, 'Plans'), { recursive: true });
  fs.writeFileSync(path.join(work, 'notes.md'), 'hello notes');
  fs.writeFileSync(path.join(work, 'Budget.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(work, '.git'));
  fs.writeFileSync(path.join(work, '.git', 'config'), 'x');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'not yours');
  fs.symlinkSync(path.join(outside, 'private.txt'), path.join(work, 'link.txt'));
  fs.mkdirSync(path.join(home, 'Library', 'Mail'), { recursive: true });
  fs.mkdirSync(path.join(home, '.secret'), { recursive: true });
  const files = filesSource({ hub: f.hub, home });
  return { ...f, home, outside, work, files };
}

test('folders: only inside home, never home itself, ~/Library, hidden, a file or a missing path', async () => {
  const s = setup();
  assert.throws(() => s.files.addFolder(s.work), codeOf('not_connected'));
  assert.deepEqual(await s.files.connect(), { connected: true, grant: 'granted' });
  assert.deepEqual(s.files.addFolder('~/Documents/Work'), ['~/Documents/Work']);
  assert.deepEqual(s.files.addFolder(s.work), ['~/Documents/Work'], 'the same folder once');
  assert.throws(
    () => s.files.addFolder('~'),
    (e: any) => codeOf('outside')(e) && /not the home folder itself/.test(e.message),
  );
  assert.throws(
    () => s.files.addFolder(s.outside),
    (e: any) => codeOf('outside')(e) && /inside your home/.test(e.message),
  );
  assert.throws(() => s.files.addFolder('~/Library/Mail'), /~\/Library/);
  assert.throws(() => s.files.addFolder('~/.secret'), /Hidden/);
  assert.throws(
    () => s.files.addFolder('~/Documents/Work/notes.md'),
    (e: any) => codeOf('bad_args')(e) && /not a folder/.test(e.message),
  );
  assert.throws(
    () => s.files.addFolder('~/Nope'),
    (e: any) => codeOf('bad_args')(e) && /doesn't exist/.test(e.message),
  );
  assert.throws(() => s.files.addFolder('Documents'), /not an absolute path/);
  assert.throws(() => s.files.addFolder(''), /A path is needed/);
  assert.throws(() => s.files.addFolder(7), /A path is needed/);
  assert.deepEqual(await s.files.detail(), ['~/Documents/Work']);
  assert.deepEqual(s.files.removeFolder('~/Documents/Work'), []);
  s.files.addFolder(s.work);
  assert.deepEqual(s.files.removeFolder(s.work), [], 'by its stored path too');
});

test('list: the added folders, then a folder inside one, hidden names left out, links marked', async () => {
  const s = setup();
  await s.files.connect();
  const empty = await s.files.list({}, 'momo-main');
  assert.deepEqual(empty, { count: 0, folder: null, entries: [], truncated: false });
  s.files.addFolder(s.work);
  assert.deepEqual((await s.files.list({}, 'momo-main')).entries, [{ path: '~/Documents/Work', kind: 'folder' }]);
  const r = await s.files.list({ path: '~/Documents/Work' }, 'momo-main');
  assert.equal(r.folder, '~/Documents/Work');
  assert.deepEqual(
    r.entries.map((e: any) => [e.path, e.kind, e.size]),
    [
      ['~/Documents/Work/Budget.csv', 'file', 8],
      ['~/Documents/Work/link.txt', 'link', undefined],
      ['~/Documents/Work/notes.md', 'file', 11],
      ['~/Documents/Work/Plans', 'folder', undefined],
    ],
  );
  assert.ok(r.entries.every((e: any) => typeof e.modified === 'number'));
  const matched = await s.files.list({ path: s.work, match: ' NOTES ' }, 'momo-main');
  assert.deepEqual(
    matched.entries.map((e: any) => e.path),
    ['~/Documents/Work/notes.md'],
  );
  assert.deepEqual(
    s.decided.map((d: any) => [d.action, d.summary, d.private]),
    [
      ['files.list', 'list the added folders', true],
      ['files.list', 'list the added folders', true],
      ['files.list', 'list one folder', true],
      ['files.list', 'list one folder', true],
    ],
  );
  await assert.rejects(s.files.list({ path: '~/Documents/Work/notes.md' }, 'c'), /is a file/);
});

test('list is capped and says so', async () => {
  const s = setup();
  await s.files.connect();
  const many = path.join(s.home, 'Many');
  fs.mkdirSync(many);
  for (let i = 0; i <= MAX_ENTRIES; i++) fs.writeFileSync(path.join(many, `f${String(i).padStart(4, '0')}`), '');
  s.files.addFolder(many);
  const r = await s.files.list({ path: many }, 'c');
  assert.equal(r.count, MAX_ENTRIES);
  assert.equal(r.truncated, true);
});

test('guards: outside every folder, a link that leads out, hidden names, home itself and a removed folder', async () => {
  const s = setup();
  await s.files.connect();
  s.files.addFolder(s.work);
  const outside = (e: any) => codeOf('outside')(e);
  await assert.rejects(s.files.read({ path: path.join(s.outside, 'private.txt') }, 'c'), outside);
  await assert.rejects(s.files.read({ path: '~/Documents/Work/link.txt' }, 'c'), outside);
  await assert.rejects(s.files.read({ path: '~/Documents/Work/../Work/../../.secret' }, 'c'), outside);
  await assert.rejects(s.files.read({ path: '~/Documents/Work/.env' }, 'c'), (e: any) => outside(e) && /hidden/.test(e.message));
  await assert.rejects(s.files.list({ path: '~/Documents/Work/.git' }, 'c'), /hidden/);
  // a visible name that is a link to a hidden folder in the same folder
  fs.symlinkSync(path.join(s.work, '.git'), path.join(s.work, 'vis'));
  await assert.rejects(
    s.files.read({ path: '~/Documents/Work/vis/config' }, 'c'),
    (e: any) => codeOf('outside')(e) && /is hidden/.test(e.message),
  );
  await assert.rejects(s.files.list({ path: '~' }, 'c'), outside);
  await assert.rejects(s.files.read({ path: '~/Documents/Work/missing.md' }, 'c'), codeOf('bad_args'));
  // a folder deleted from disk since it was added is skipped, not an error
  const gone = path.join(s.home, 'Gone');
  fs.mkdirSync(gone);
  s.files.addFolder(gone);
  fs.rmSync(gone, { recursive: true });
  await assert.rejects(s.files.read({ path: '~/Documents/Work/../../Library/Mail' }, 'c'), outside);
  // a stored folder that no longer passes the rules (state from elsewhere) reads nothing
  s.hub.setFolders([path.join(s.home, 'Library')]);
  await assert.rejects(s.files.list({ path: '~/Library/Mail' }, 'c'), outside);
  assert.ok(s.audited.every((a: any) => a.result !== 'done'));
});

test('read: text from an offset, size-bounded, binaries refused, folders refused', async () => {
  const s = setup();
  await s.files.connect();
  s.files.addFolder(s.work);
  const r = await s.files.read({ path: '~/Documents/Work/notes.md' }, 'momo-main');
  assert.deepEqual(r, {
    count: 1,
    path: '~/Documents/Work/notes.md',
    text: 'hello notes',
    size: 11,
    offset: 0,
    bytes: 11,
    truncated: false,
  });
  const part = await s.files.read({ path: '~/Documents/Work/notes.md', offset: 6, maxBytes: 3 }, 'c');
  assert.deepEqual([part.text, part.truncated, part.bytes], ['not', true, 3]);
  const past = await s.files.read({ path: '~/Documents/Work/notes.md', offset: 99 }, 'c');
  assert.deepEqual([past.text, past.bytes], ['', 0]);
  const big = path.join(s.work, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(MAX_READ + 10));
  assert.equal((await s.files.read({ path: big }, 'c')).bytes, DEFAULT_READ);
  assert.equal((await s.files.read({ path: big, maxBytes: 10 ** 9 }, 'c')).bytes, MAX_READ);
  assert.equal((await s.files.read({ path: big, maxBytes: -5, offset: -3 }, 'c')).offset, 0);
  fs.writeFileSync(path.join(s.work, 'img.png'), Buffer.from([0x89, 0x50, 0, 1]));
  await assert.rejects(s.files.read({ path: '~/Documents/Work/img.png' }, 'c'), /not a text file/);
  await assert.rejects(s.files.read({ path: '~/Documents/Work/Plans' }, 'c'), /is a folder/);
  fs.writeFileSync(path.join(s.work, 'empty.txt'), '');
  assert.equal((await s.files.read({ path: '~/Documents/Work/empty.txt' }, 'c')).text, '');
  assert.equal(
    s.decided.every((d: any) => d.action === 'files.read' && d.summary === 'read one file'),
    true,
  );
});

test('Blocked or disconnected Files reads nothing', async () => {
  const s = setup();
  await s.files.connect();
  s.files.addFolder(s.work);
  s.hub.setLevel('files', 'blocked');
  await assert.rejects(s.files.read({ path: '~/Documents/Work/notes.md' }, 'c'), codeOf('blocked'));
  s.hub.disconnect('files');
  await assert.rejects(s.files.list({}, 'c'), codeOf('not_connected'));
  assert.deepEqual(await s.files.detail(), []);
});

test('paths outside home are shown as they are', async () => {
  const s = setup();
  await s.files.connect();
  s.hub.setFolders([s.home, s.outside]);
  // shown as they are: home as ~, anything outside it in full
  assert.deepEqual(await s.files.detail(), ['~', s.outside]);
  // the folder fails the rules, so it reads nothing, and the refusal names the full path
  await assert.rejects(s.files.list({ path: s.outside }, 'c'), (e: any) => e.message.includes(s.outside));
});

/** A Files source over fs, but whose `promises[name]` first runs `swap()` once (a change on disk between two steps). */
function racing(s: any, name: 'open' | 'readdir' | 'realpath', swap: () => void, when: 'before' | 'after' = 'before') {
  let done = false;
  const real = (fs.promises as any)[name].bind(fs.promises);
  const promises = {
    ...fs.promises,
    [name]: async (...a: any[]) => {
      if (done) return real(...a);
      done = true;
      if (when === 'before') swap();
      const r = await real(...a);
      if (when === 'after') swap();
      return r;
    },
  };
  return filesSource({ hub: s.hub, home: s.home, fs: { ...fs, realpathSync: fs.realpathSync, constants: fs.constants, promises } as any });
}

test('a parent folder swapped for a link to outside, before or after the file is opened, is not read', async () => {
  const s = setup();
  await s.files.connect();
  s.files.addFolder(s.work);
  const sub = path.join(s.work, 'Plans');
  fs.writeFileSync(path.join(sub, 'plan.md'), 'inside');
  fs.writeFileSync(path.join(s.outside, 'plan.md'), 'OUTSIDE');
  const swap = () => {
    fs.renameSync(sub, `${sub}.old`);
    fs.symlinkSync(s.outside, sub);
  };
  const unswap = () => {
    fs.rmSync(sub);
    fs.renameSync(`${sub}.old`, sub);
  };
  const wanted = '~/Documents/Work/Plans/plan.md';
  // swapped between the check and the open: the handle is the outside file, not the one checked
  await assert.rejects(
    racing(s, 'open', swap).read({ path: wanted }, 'c'),
    (e: any) => codeOf('outside')(e) && /changed while it was read/.test(e.message),
  );
  unswap();
  // swapped right after the open: the path no longer leads to the file held
  await assert.rejects(racing(s, 'open', swap, 'after').read({ path: wanted }, 'c'), /changed while it was read/);
  unswap();
  // a folder listed after its parent was swapped
  await assert.rejects(racing(s, 'readdir', swap).list({ path: '~/Documents/Work/Plans' }, 'c'), /changed while it was read/);
  unswap();
  assert.equal((await s.files.read({ path: wanted }, 'c')).text, 'inside');
  // a file that turned into a link at the last step is not opened through it
  const notes = path.join(s.work, 'notes.md');
  await assert.rejects(
    racing(s, 'open', () => {
      fs.renameSync(notes, `${notes}.old`);
      fs.symlinkSync(path.join(s.outside, 'private.txt'), notes);
    }).read({ path: notes }, 'c'),
    /changed while it was read/,
  );
  fs.rmSync(notes);
  fs.renameSync(`${notes}.old`, notes);
  // right after the open, the path re-pointed at another file in the same folder: not the file held
  await assert.rejects(
    racing(
      s,
      'open',
      () => {
        fs.renameSync(notes, `${notes}.old`);
        fs.symlinkSync(path.join(s.work, 'Budget.csv'), notes);
      },
      'after',
    ).read({ path: notes }, 'c'),
    /changed while it was read/,
  );
  fs.rmSync(notes);
  fs.renameSync(`${notes}.old`, notes);
  // the file replaced by another file between the check and the open
  await assert.rejects(
    racing(s, 'open', () => {
      // the old file is kept (renamed), so the new one can't reuse its inode number
      fs.renameSync(notes, `${notes}.prev`);
      fs.writeFileSync(notes, 'new');
    }).read({ path: notes }, 'c'),
    /changed while it was read/,
  );
});

test('nothing about a path outside the folders is revealed, not even whether it exists', async () => {
  const s = setup();
  await s.files.connect();
  s.files.addFolder(s.work);
  const existing = path.join(s.outside, 'private.txt');
  const missing = path.join(s.outside, 'nope.txt');
  for (const p of [existing, missing, '/etc/hosts', '/nonexistent/x']) {
    await assert.rejects(
      s.files.read({ path: p }, 'c'),
      (e: any) => codeOf('outside')(e) && e.message === `${p} isn't in a folder the user added to MoMo`,
    );
  }
  // inside a folder, a missing file says so, by the path as given
  await assert.rejects(
    s.files.read({ path: ' ~/Documents/Work/missing.md ' }, 'c'),
    (e: any) => e.message === "~/Documents/Work/missing.md doesn't exist",
  );
});

test('~/Library in any case is a system folder; a folder deleted since it was added is skipped and recorded', async () => {
  const s = setup();
  await s.files.connect();
  // on a case-insensitive disk (macOS) these are one folder; on a case-sensitive one (Linux CI) three, all refused
  for (const p of ['Library/Application Support', 'library/Application Support', 'LIBRARY/Mail'])
    fs.mkdirSync(path.join(s.home, p), { recursive: true });
  for (const p of ['~/library/Application Support', '~/LIBRARY/Mail', '~/Library']) assert.throws(() => s.files.addFolder(p), /~\/Library/);
  s.files.addFolder(s.work);
  const gone = path.join(s.home, 'Gone');
  fs.mkdirSync(gone);
  s.files.addFolder(gone);
  fs.rmSync(gone, { recursive: true });
  assert.equal((await s.files.read({ path: '~/Documents/Work/notes.md' }, 'c')).text, 'hello notes');
  // a stored folder that can't be resolved for another reason is recorded, not hidden
  const loop = path.join(s.home, 'Loop');
  fs.symlinkSync(loop, loop);
  s.hub.setFolders([loop, s.work]);
  assert.equal((await s.files.read({ path: '~/Documents/Work/notes.md' }, 'c')).text, 'hello notes');
  assert.ok(recentIgnored().some((x: any) => x.context === 'resolve a MoMo Files folder' && /ELOOP/.test(x.message)));
});

test('binary content at the read offset is refused; a read never ends inside a character', async () => {
  const s = setup();
  await s.files.connect();
  s.files.addFolder(s.work);
  const mixed = path.join(s.work, 'mixed.log');
  fs.writeFileSync(mixed, Buffer.concat([Buffer.from('x'.repeat(10_000)), Buffer.from([0, 1, 2]), Buffer.from('tail')]));
  assert.equal((await s.files.read({ path: mixed, maxBytes: 100 }, 'c')).bytes, 100, 'the text part reads');
  await assert.rejects(s.files.read({ path: mixed, offset: 9_990 }, 'c'), /not a text file/);
  const utf = path.join(s.work, 'utf.txt');
  fs.writeFileSync(utf, 'aé中😀');
  const one = await s.files.read({ path: utf, maxBytes: 2 }, 'c');
  assert.deepEqual([one.text, one.bytes, one.truncated], ['a', 1, true]);
  const two = await s.files.read({ path: utf, offset: 1, maxBytes: 4 }, 'c');
  assert.deepEqual([two.text, two.bytes], ['é', 2]);
  const all = await s.files.read({ path: utf }, 'c');
  assert.deepEqual([all.text, all.truncated], ['aé中😀', false]);
});

test('wholeChars keeps whole characters only', () => {
  const b = (...x: number[]) => Buffer.from(x);
  assert.deepEqual(wholeChars(Buffer.from('ab')), Buffer.from('ab'));
  assert.deepEqual(wholeChars(Buffer.from('aé')), Buffer.from('aé'));
  assert.deepEqual(wholeChars(Buffer.from('a中').subarray(0, 3)), Buffer.from('a'));
  assert.deepEqual(wholeChars(Buffer.from('a😀').subarray(0, 4)), Buffer.from('a'));
  assert.deepEqual(wholeChars(Buffer.from('😀')), Buffer.from('😀'));
  assert.deepEqual(wholeChars(b(0xc3)), b());
  // continuation bytes with no lead within reach are kept as they are
  assert.deepEqual(wholeChars(b(0x80, 0x80, 0x80, 0x80, 0x80)), b(0x80, 0x80, 0x80, 0x80, 0x80));
});
