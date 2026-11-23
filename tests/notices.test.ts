// Settings > About opens the shipped third-party notices (electron/support/notices.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { noticesPath, openNotices, FILE } = require('../electron/support/notices.cjs');

test('a packaged build reads the Resources copy, a checkout reads build/', () => {
  const res = path.join('/app/Resources', FILE);
  const dev = path.join('/repo', 'build', FILE);
  assert.equal(noticesPath({ resourcesPath: '/app/Resources', appPath: '/repo', exists: (p: string) => p === res || p === dev }), res);
  assert.equal(noticesPath({ resourcesPath: '/elsewhere', appPath: '/repo', exists: (p: string) => p === dev }), dev);
  assert.equal(noticesPath({ resourcesPath: '/elsewhere', appPath: '/repo', exists: () => false }), null);
});

test('openNotices opens the file, and reports a missing file or an open error', async () => {
  const opened: string[] = [];
  const ok = await openNotices({ openPath: async (p: string) => (opened.push(p), ''), appPath: process.cwd() });
  assert.equal(ok.ok, true);
  assert.deepEqual(opened, [path.join(process.cwd(), 'build', FILE)]);
  assert.equal((await openNotices({ openPath: async () => 'no app', appPath: process.cwd() })).error, 'no app');
  const missing = await openNotices({ openPath: async () => '', appPath: '/nonexistent' });
  assert.equal(missing.ok, false);
});
