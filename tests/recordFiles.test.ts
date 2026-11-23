// The chat store's record files (electron/platform/recordFiles.cjs) through the Rust core: a folder read at once
// (store.readRecords), and one record written whole (store.writeRecord) with the bytes, modes and errors fsutil's
// writeAtomic had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import util from 'node:util';

const require = createRequire(import.meta.url);
const { readRecordFiles, writeRecordFile } = require('../electron/platform/recordFiles.cjs');
const { writeAtomic } = require('../electron/platform/fsutil.cjs');
const { keepPrivate } = require('../electron/platform/privateFiles.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const { core } = require('../electron/platform/core.cjs');

/** A folder holding every kind of file the chat store meets, removed after the test. */
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-records-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, bytes: string | Buffer) => fs.writeFileSync(path.join(dir, name), bytes);
  put('b.v2', JSON.stringify({ id: 'b', meta: { title: 'Ünïcödé "quoted"\n' } }));
  put('a.v2', '{"id":"a","n":[1,2,{"x":null}]}');
  put('Z.v2', '{not json');
  put('bom.v2', '﻿{}');
  put('bad-utf8.v2', Buffer.from([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  put('surrogate.v2', '{"t":"\\ud800"}');
  put('null.v2', 'null');
  put('other.json', '{}');
  put(`${encodeURIComponent('claude:ü x')}.v2`, '{"id":"claude:ü x"}');
  fs.mkdirSync(path.join(dir, 'folder.v2'));
  return dir;
}

test('every kind of file reads in folder order, unreadable ones as null', (t) => {
  const dir = fixture(t);
  const { entries } = readRecordFiles(dir, '.v2');
  const named = (name: string) => entries.find((e: { name: string }) => e.name === name);
  assert.deepEqual(
    entries.map((e: { name: string }) => e.name),
    fs.readdirSync(dir).filter((n) => n.endsWith('.v2')),
  );
  assert.equal(named('Z.v2').record, null);
  assert.equal(named('folder.v2').record, null);
  assert.deepEqual(named('a.v2').record, { id: 'a', n: [1, 2, { x: null }] });
  assert.deepEqual(named('b.v2').record, { id: 'b', meta: { title: 'Ünïcödé "quoted"\n' } });
});

test("the core's reply: values parsed already, text parsed here as readJson would, unread files null", () => {
  const asked: string[] = [];
  const addon = {
    dispatchSync: (route: string, payload: Buffer) => {
      asked.push(`${route} ${payload}`);
      return Buffer.from(
        JSON.stringify([
          ['a.v2', 0, { id: 'a' }],
          ['b.v2', 1, '{"id":"b"}'],
          ['c.v2', 1, '{oops'],
          ['d.v2', 2],
        ]),
      );
    },
  };
  assert.deepEqual(readRecordFiles('/chats', '.v2', { addon }), {
    entries: [
      { name: 'a.v2', record: { id: 'a' } },
      { name: 'b.v2', record: { id: 'b' } },
      { name: 'c.v2', record: null },
      { name: 'd.v2', record: null },
    ],
  });
  assert.deepEqual(asked, ['store.readRecords /chats\n.v2']);
});

test('no core, or one that fails, is the error of the read', () => {
  // no core: the error every core call throws, not a TypeError from reading null
  assert.equal((readRecordFiles('/chats', '.v2', { addon: null }).error as Error).message, 'The Rust core is missing.');
  const failing = {
    dispatchSync: () => {
      throw new Error('list: permission denied');
    },
  };
  assert.match(String(readRecordFiles('/chats', '.v2', { addon: failing }).error), /permission denied/);
  assert.ok(readRecordFiles('/chats', '.v2', { addon: { dispatchSync: () => Buffer.from('not json') } }).error);
});

test('a folder that does not exist is ENOENT, which a first start expects', () => {
  const missing = path.join(os.tmpdir(), `mopilot-records-missing-${process.pid}`);
  const read = readRecordFiles(missing, '.v2');
  assert.equal(read.entries, undefined);
  assert.equal((read.error as NodeJS.ErrnoException).code, 'ENOENT');
});

/** A scratch folder, made writable again and removed after the test. */
function scratch(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-record-write-')));
  t.after(() => {
    if (fs.existsSync(path.join(dir, 'ro'))) fs.chmodSync(path.join(dir, 'ro'), 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const mode = (file: string) => fs.statSync(file).mode & 0o777;
/** A message with its random temporary file's name made one name, so two writes' errors compare. */
const sameTemp = (message: string) => message.replace(/\.mopilot-\d+-[0-9a-f-]+\.tmp/g, '.mopilot-<temp>.tmp');
/** What `write` throws. */
const thrown = (write: () => void) => {
  try {
    write();
  } catch (error) {
    return error as NodeJS.ErrnoException & { dest?: string };
  }
  return assert.fail('it did not throw');
};

test('a record is the same bytes writeAtomic wrote, small or a megabyte, with any text in it', (t) => {
  const dir = scratch(t);
  const records = {
    small: JSON.stringify({ id: 'claude:a', meta: { title: 'Ünïcödé "quoted"\n', emoji: '🦀' } }),
    // a raw lone surrogate (JSON.stringify would have escaped it), which both write as U+FFFD
    surrogate: '{"id":"x","t":"a\ud800b\udc00"}',
    large: JSON.stringify({ id: 'big', segments: [], meta: { notes: 'é'.repeat(512 * 1024) } }),
    empty: '',
  };
  for (const [name, text] of Object.entries(records)) {
    writeAtomic(path.join(dir, `${name}.old`), text);
    writeRecordFile(path.join(dir, `${name}.v2`), text);
    assert.ok(fs.readFileSync(path.join(dir, `${name}.v2`)).equals(fs.readFileSync(path.join(dir, `${name}.old`))), name);
  }
  assert.ok(fs.statSync(path.join(dir, 'large.v2')).size > 1 << 20);
  // no temporary file stays
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    [],
  );
});

test('permissions are what writeAtomic gave: owner-only in the data folder, kept outside it', {
  skip: process.platform === 'win32',
}, (t) => {
  const dir = scratch(t);
  const data = path.join(dir, 'data');
  keepPrivate(data);
  for (const [name, had] of [
    ['new', null],
    ['open', 0o644],
    ['exec', 0o750],
  ] as const) {
    for (const [ext, write] of [
      ['old', writeAtomic],
      ['v2', writeRecordFile],
    ] as const) {
      const file = path.join(data, 'threads', `${name}.${ext}`);
      if (had !== null) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'old');
        fs.chmodSync(file, had);
      }
      write(file, '{}');
    }
    assert.equal(mode(path.join(data, 'threads', `${name}.v2`)), mode(path.join(data, 'threads', `${name}.old`)), name);
  }
  assert.equal(mode(path.join(data, 'threads', 'new.v2')), 0o600);
  assert.equal(mode(path.join(data, 'threads')), 0o700);
  const outside = path.join(dir, 'shared.v2');
  fs.writeFileSync(outside, 'old');
  fs.chmodSync(outside, 0o644);
  writeRecordFile(outside, '{}');
  assert.equal(mode(outside), 0o644);
});

test('a write the disk refuses throws what writeAtomic threw, and the old file stays whole', {
  skip: process.platform === 'win32',
}, (t) => {
  const dir = scratch(t);
  // a folder that went read-only
  const ro = path.join(dir, 'ro');
  fs.mkdirSync(ro);
  fs.writeFileSync(path.join(ro, 'x.v2'), 'old');
  fs.chmodSync(ro, 0o500);
  const denied = thrown(() => writeRecordFile(path.join(ro, 'x.v2'), '{}'));
  // root writes anywhere: then nothing is refused
  if (denied.code === 'EACCES') {
    const before = thrown(() => writeAtomic(path.join(ro, 'x.v2'), '{}'));
    assert.equal(sameTemp(denied.message), sameTemp(before.message));
    assert.deepEqual([denied.code, denied.syscall, denied.dest], ['EACCES', 'open', undefined]);
    assert.match(String(denied.path), /\.mopilot-\d+-[0-9a-f-]+\.tmp$/);
  }
  fs.chmodSync(ro, 0o700);
  assert.deepEqual([fs.readdirSync(ro), fs.readFileSync(path.join(ro, 'x.v2'), 'utf8')], [['x.v2'], 'old']);
  // a name past what the folder takes, and a folder in the record's place: the same errors, word for word
  const long = path.join(dir, `${'n'.repeat(300)}.v2`);
  assert.equal(thrown(() => writeRecordFile(long, '{}')).message, thrown(() => writeAtomic(long, '{}')).message);
  assert.equal(thrown(() => writeRecordFile(long, '{}')).code, 'ENAMETOOLONG');
  fs.mkdirSync(path.join(dir, 'folder.v2', 'inside'), { recursive: true });
  const onto = thrown(() => writeRecordFile(path.join(dir, 'folder.v2'), '{}'));
  assert.equal(sameTemp(onto.message), sameTemp(thrown(() => writeAtomic(path.join(dir, 'folder.v2'), '{}')).message));
  assert.equal(onto.dest, path.join(dir, 'folder.v2'));
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    [],
  );
});

test("a full disk is Node's ENOSPC, a temporary file left behind is noted, and a failure that isn't the write's comes as it is", () => {
  clearIgnored();
  const failing = (message: string) => ({
    dispatchSync: () => {
      throw new Error(message);
    },
  });
  const full = JSON.stringify({
    code: 'ENOSPC',
    syscall: 'write',
    path: null,
    dest: null,
    message: 'ENOSPC: no space left on device, write',
    cleanup: "EBUSY: resource busy or locked, rm '/d/.t.tmp'",
  });
  const error = thrown(() => writeRecordFile('/d/x.v2', '{}', { addon: failing(full) }));
  assert.deepEqual(
    { message: error.message, code: error.code, syscall: error.syscall, path: error.path, dest: error.dest },
    { message: 'ENOSPC: no space left on device, write', code: 'ENOSPC', syscall: 'write', path: undefined, dest: undefined },
  );
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['remove a temporary file after a failed write', "EBUSY: resource busy or locked, rm '/d/.t.tmp'"]],
  );
  for (const other of ['core route store.writeRecord panicked', '{"code":"X"}', 'null'])
    assert.equal(thrown(() => writeRecordFile('/d/x.v2', '{}', { addon: failing(other) })).message, other);
  // what is thrown need not be an Error
  const odd = { code: 'ENOSPC' };
  const notAnError = {
    dispatchSync: () => {
      throw odd;
    },
  };
  assert.equal(
    thrown(() => writeRecordFile('/d/x.v2', '{}', { addon: notAnError })),
    odd,
  );
  // no core: the error every core call throws, and nothing written
  assert.throws(() => writeRecordFile('/d/x.v2', '{}', { addon: null }), { message: 'The Rust core is missing.' });
  // a checkout whose core was built before the route: told how to rebuild it
  assert.match(
    thrown(() => writeRecordFile('/d/x.v2', '{}', { addon: failing('no core route store.writeRecord') })).message,
    /predates store\.writeRecord.*rebuild it \(cargo build --release -p node in core\/\)$/,
  );
});

test("every OS error the core names, it names as this platform's Node does, and it knows every one Node names", () => {
  const rows: [number, string, string][] = JSON.parse(String(core().dispatchSync('store.errorNames', Buffer.alloc(0))));
  const node = util.getSystemErrorMap();
  if (process.platform === 'win32') {
    // Windows codes are Win32's, translated by libuv (uv_translate_sys_error): each lands on a name and text Node has
    const named = new Set([...node.values()].map(([code, text]) => `${code}: ${text}`));
    assert.deepEqual(
      rows.filter(([, code, text]) => !named.has(`${code}: ${text}`)),
      [],
    );
    return;
  }
  assert.deepEqual(
    rows.filter(([errno, code, text]) => JSON.stringify(node.get(-errno)) !== JSON.stringify([code, text])),
    [],
  );
  // libuv's own codes (getaddrinfo's, and ones for an errno this system lacks) sit at -3000 and below
  const known = new Set(rows.map(([errno]) => -errno));
  assert.deepEqual(
    [...node].filter(([n]) => n > -3000 && !known.has(n)),
    [],
  );
});

test('the core is asked once, with the file, its temporary sibling, whether it is private and the bytes', () => {
  const asked: Buffer[] = [];
  const addon = { dispatchSync: (_route: string, payload: Buffer) => (asked.push(payload), Buffer.alloc(0)) };
  writeRecordFile('/d/x.v2', '{"a":"\\n"}', { addon });
  assert.equal(asked.length, 1);
  const text = String(asked[0]);
  const head = JSON.parse(text.slice(0, text.indexOf('\n')));
  assert.deepEqual({ ...head, temp: path.dirname(head.temp) }, { file: '/d/x.v2', temp: '/d', private: false });
  assert.equal(text.slice(text.indexOf('\n') + 1), '{"a":"\\n"}');
});
