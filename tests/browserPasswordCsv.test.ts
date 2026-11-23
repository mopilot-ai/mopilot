// A passwords file another browser exported (electron/capabilities/browser/import/passwordCsv.cjs): CSV parsing, Safari's and
// Chrome's columns, rows left out, and files that are not an export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseCsv, readPasswordsCsv, MAX_BYTES } = require('../electron/capabilities/browser/import/passwordCsv.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'password-csv-test-'));
const write = (text: string) => {
  const file = path.join(tmp(), 'Passwords.csv');
  fs.writeFileSync(file, text);
  return file;
};

test('parseCsv: quotes, doubled quotes, commas and line breaks inside fields, CRLF, a byte order mark, a missing last newline', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"two\nlines",\nlast,row'), [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
    ['two\nlines', ''],
    ['last', 'row'],
  ]);
  assert.deepEqual(parseCsv('a\rb\n'), [['a'], ['b']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a,'), [['a', '']]);
});

test("readPasswordsCsv: Safari's export, one login per origin and user (the last row wins); rows without a web address or a password are counted", async () => {
  const file = write(
    [
      'Title,URL,Username,Password,Notes,OTPAuth',
      'GitHub,https://github.com/login,ann,"p,w""1",note,',
      'GitHub again,https://github.com/session,ann,pw2,,',
      'Bob,https://github.com/,bob,pwb,,',
      '',
      'App,ftp://files.test/,x,y,,',
      'Nothing,,x,y,,',
      'NoPassword,https://a.test/,x,,,',
      '',
    ].join('\n'),
  );
  const out = await readPasswordsCsv(file);
  assert.deepEqual(out.logins, [
    { origin: 'https://github.com', username: 'ann', password: 'pw2' },
    { origin: 'https://github.com', username: 'bob', password: 'pwb' },
  ]);
  assert.deepEqual(out.stats, { total: 6, imported: 2, invalid: 3 });
});

test("readPasswordsCsv: Chrome's and other managers' column names; no user name column means none", async () => {
  const chrome = await readPasswordsCsv(write('name,url,username,password,note\nex,https://ex.test/,me,pw,\n'));
  assert.deepEqual(chrome.logins, [{ origin: 'https://ex.test', username: 'me', password: 'pw' }]);
  const bare = await readPasswordsCsv(write('Website,Password\nhttp://plain.test/a,pw\nhttp://plain.test/b,pw\n'));
  assert.deepEqual(bare.logins, [{ origin: 'http://plain.test', username: '', password: 'pw' }]);
  // a short row: the missing cells are empty
  const short = await readPasswordsCsv(write('url,username,password\nhttps://s.test/\n'));
  assert.deepEqual(short.stats, { total: 1, imported: 0, invalid: 1 });
  const noUrlCell = await readPasswordsCsv(write('username,url,password\nme\n'));
  assert.deepEqual(noUrlCell.stats, { total: 1, imported: 0, invalid: 1 });
  // a bare host is a web login over https
  const bareHost = await readPasswordsCsv(write('url,password\n  accounts.example.com/login ,pw\n'));
  assert.deepEqual(bareHost.logins, [{ origin: 'https://accounts.example.com', username: '', password: 'pw' }]);
  const noUser = await readPasswordsCsv(write('url,password,username\nhttps://u.test/,pw\n'));
  assert.deepEqual(noUser.logins, [{ origin: 'https://u.test', username: '', password: 'pw' }]);
});

test('readPasswordsCsv: a file that is not a passwords export, not a file, too large or gone', async () => {
  await assert.rejects(() => readPasswordsCsv(write('Title,Notes\na,b\n')), { code: 'unsupported' });
  await assert.rejects(() => readPasswordsCsv(write('')), { code: 'unsupported' });
  await assert.rejects(() => readPasswordsCsv(tmp()), { code: 'unsupported' });
  await assert.rejects(() => readPasswordsCsv(path.join(tmp(), 'gone.csv')), { code: 'missing' });
  const big = {
    promises: { lstat: async () => ({ isFile: () => true, size: MAX_BYTES + 1 }), readFile: async () => '' },
  };
  await assert.rejects(() => readPasswordsCsv('/x.csv', { fs: big }), { code: 'too_large' });
  const denied = {
    promises: {
      lstat: async () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      },
    },
  };
  await assert.rejects(() => readPasswordsCsv('/x.csv', { fs: denied }), { code: 'access_blocked' });
  // a symbolic link is not followed
  const dir = tmp();
  const real = write('url,password\nhttps://a.test/,pw\n');
  fs.symlinkSync(real, path.join(dir, 'link.csv'));
  await assert.rejects(() => readPasswordsCsv(path.join(dir, 'link.csv')), { code: 'unsupported' });
});
