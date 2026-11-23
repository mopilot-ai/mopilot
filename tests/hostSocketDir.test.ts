// The folder a Host's socket is in when its data dir is too deep for a socket path (host/src/paths.mjs ensureSocketDir, host/src/server.mjs): it is this user's own and closed to others, and a name another user made first is refused.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createPaths, ensureSocketDir } from '../host/src/paths.mjs';
// @ts-ignore: plain ESM without declarations
import { startServer } from '../host/src/server.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sock-dir-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const me = process.getuid!();
const deep = (name: string) => path.join(base, name, 'x'.repeat(100));

test('M: the socket of a deep data dir is in a folder named for the user, in the runtime folder when there is one', () => {
  const a = createPaths({ dataDir: deep('a'), env: {}, tmp: '/t', uid: 7 });
  assert.match(a.socketPath, /^\/t\/mopilot-host-7\/[0-9a-f]{12}\.sock$/);
  const b = createPaths({ dataDir: deep('a'), env: { XDG_RUNTIME_DIR: '/run/user/7' }, tmp: '/t', uid: 7 });
  assert.match(b.socketPath, /^\/run\/user\/7\/mopilot-host-7\/[0-9a-f]{12}\.sock$/);
  assert.notEqual(createPaths({ dataDir: deep('b'), env: {}, tmp: '/t', uid: 7 }).socketPath, a.socketPath);
  assert.equal(createPaths({ dataDir: deep('a'), env: {}, tmp: '/t', uid: 8 }).socketPath.includes('mopilot-host-8'), true);
  // a short data dir keeps its socket inside it
  assert.equal(createPaths({ dataDir: '/d', env: {}, tmp: '/t' }).socketPath, '/d/host.sock');
});

test('M: ensureSocketDir makes the folder owner-only, accepts the one it made, and refuses a link, a file, an open folder and another user’s', () => {
  const dir = path.join(base, 'mine', 'sockets');
  ensureSocketDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  ensureSocketDir(dir);
  const open = path.join(base, 'open');
  fs.mkdirSync(open, { mode: 0o777 });
  fs.chmodSync(open, 0o777);
  assert.throws(() => ensureSocketDir(open), /not a private folder/);
  const group = path.join(base, 'group');
  fs.mkdirSync(group);
  fs.chmodSync(group, 0o750);
  assert.throws(() => ensureSocketDir(group), /not a private folder/);
  const file = path.join(base, 'file');
  fs.writeFileSync(file, '');
  assert.throws(() => ensureSocketDir(file), /not a private folder/);
  const link = path.join(base, 'link');
  fs.symlinkSync(dir, link);
  assert.throws(() => ensureSocketDir(link), /not a private folder/);
  // the folder is there and private, but belongs to someone else
  assert.throws(() => ensureSocketDir(dir, { uid: me + 1 }), /not a private folder/);
  // anything but "not there" is an error of its own
  assert.throws(() => ensureSocketDir(path.join(file, 'below')), { code: 'ENOTDIR' });
});

test('M: serve with a deep data dir takes its socket only in a private folder of the user’s', async () => {
  // short: a socket path must fit sockaddr_un, and this machine's temp folder can be long
  const tmp = fs.mkdtempSync('/tmp/sd-');
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // another user's name taken first: the Host does not start
  fs.mkdirSync(path.join(tmp, `mopilot-host-${me}`), { mode: 0o777 });
  fs.chmodSync(path.join(tmp, `mopilot-host-${me}`), 0o777);
  const squatted = createPaths({ dataDir: deep('s'), env: {}, tmp });
  await assert.rejects(startServer({ paths: squatted }), /not a private folder/);
  fs.rmSync(path.join(tmp, `mopilot-host-${me}`), { recursive: true });
  const paths = createPaths({ dataDir: deep('s'), env: {}, tmp });
  const server = await startServer({ paths });
  assert.equal(fs.statSync(path.dirname(paths.socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.socketPath).mode & 0o777, 0o600);
  await server.close();
});
