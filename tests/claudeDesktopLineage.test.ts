// Claude desktop's side-session links (electron/harness/claude/desktopLineage.cjs): which transcript a Claude desktop
// chat started, read from its claude-code-sessions files, re-read only when a file changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createDesktopLineage, lineageOf, sessionOf } = require('../electron/harness/claude/desktopLineage.cjs');

function tmp(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-lineage-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Writes a Claude desktop session file under <appData>/claude-code-sessions/<account>/<org>. */
function session(appData: string, data: Record<string, unknown>, where = ['acct', 'org']) {
  const dir = path.join(appData, 'claude-code-sessions', ...where);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${data.sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

test('a side session maps to the transcript of the chat that started it, across accounts and orgs', async (t) => {
  const appData = tmp(t);
  session(appData, { sessionId: 'local_p', cliSessionId: 'cli-p', createdAt: 1 });
  session(appData, { sessionId: 'local_k', cliSessionId: 'cli-k', createdAt: 5, spawnedFrom: { sessionId: 'local_p', sideSession: true } });
  // a grandchild on another org's folder, its transcript known only from its last answer
  session(appData, { sessionId: 'local_g', lastAssistantCliSessionId: 'cli-g', createdAt: 9, spawnedFrom: { sessionId: 'local_k' } }, [
    'acct2',
    'org2',
  ]);
  // left out: a detached one, a parent not on file, a session without a transcript, a link to its own transcript
  session(appData, { sessionId: 'local_d', cliSessionId: 'cli-d', spawnedFrom: { sessionId: 'local_p' }, lineageDetached: true });
  session(appData, { sessionId: 'local_o', cliSessionId: 'cli-o', spawnedFrom: { sessionId: 'local_gone' } });
  session(appData, { sessionId: 'local_n', spawnedFrom: { sessionId: 'local_p' } });
  session(appData, { sessionId: 'local_s', cliSessionId: 'cli-p', spawnedFrom: { sessionId: 'local_p' } });
  // not session files: another store, a folder named like one
  fs.writeFileSync(path.join(appData, 'claude-code-sessions', 'acct', 'org', 'scheduled-tasks.json'), '{}');
  fs.mkdirSync(path.join(appData, 'claude-code-sessions', 'acct', 'org', 'local_dir.json'));
  fs.writeFileSync(path.join(appData, 'claude-code-sessions', 'stray.txt'), '');
  const lineage = createDesktopLineage({ appData: () => appData });
  assert.deepEqual(await lineage.read(), {
    'cli-k': { parentId: 'cli-p', createdAt: 5 },
    'cli-g': { parentId: 'cli-k', createdAt: 9 },
  });
});

test('a file is parsed again only once it changed; a removed or unreadable one drops out', async (t) => {
  const appData = tmp(t);
  session(appData, { sessionId: 'local_p', cliSessionId: 'cli-p' });
  const kid = session(appData, { sessionId: 'local_k', cliSessionId: 'cli-k', createdAt: 2, spawnedFrom: { sessionId: 'local_p' } });
  let reads = 0;
  const fsp = { ...fs.promises, readFile: (...a: any[]) => (reads++, (fs.promises.readFile as any)(...a)) };
  const lineage = createDesktopLineage({ appData: () => appData, fsp });
  assert.deepEqual(await lineage.read(), { 'cli-k': { parentId: 'cli-p', createdAt: 2 } });
  assert.equal(reads, 2);
  assert.deepEqual(await lineage.read(), { 'cli-k': { parentId: 'cli-p', createdAt: 2 } });
  assert.equal(reads, 2, 'unchanged files are not read again');
  // detached in Claude desktop: it stops nesting
  fs.writeFileSync(
    kid,
    JSON.stringify({ sessionId: 'local_k', cliSessionId: 'cli-k', spawnedFrom: { sessionId: 'local_p' }, lineageDetached: true, pad: 1 }),
  );
  assert.deepEqual(await lineage.read(), {});
  assert.equal(reads, 3);
  // half written: left out until it parses
  fs.writeFileSync(kid, '{"sessionId": "local_k", ');
  assert.deepEqual(await lineage.read(), {});
  fs.writeFileSync(
    kid,
    JSON.stringify({ sessionId: 'local_k', cliSessionId: 'cli-k', createdAt: 3, spawnedFrom: { sessionId: 'local_p' } }),
  );
  assert.deepEqual(await lineage.read(), { 'cli-k': { parentId: 'cli-p', createdAt: 3 } });
  fs.rmSync(kid);
  assert.deepEqual(await lineage.read(), {});
});

test('reads asked while one runs share it; no Claude desktop install reads as no links', async (t) => {
  const appData = tmp(t);
  session(appData, { sessionId: 'local_p', cliSessionId: 'cli-p' });
  let lists = 0;
  const fsp = { ...fs.promises, readdir: (...a: any[]) => (lists++, (fs.promises.readdir as any)(...a)) };
  const lineage = createDesktopLineage({ appData: () => appData, fsp });
  const [a, b] = await Promise.all([lineage.read(), lineage.read()]);
  assert.equal(a, b);
  assert.equal(lists, 3, 'one walk: the root, the account, the org');
  await lineage.read();
  assert.equal(lists, 6, 'a later read walks again');
  assert.deepEqual(await createDesktopLineage({ appData: () => path.join(appData, 'missing') }).read(), {});
});

test('an org folder that vanishes between listing and reading is skipped', async (t) => {
  const appData = tmp(t);
  session(appData, { sessionId: 'local_p', cliSessionId: 'cli-p' });
  const org = path.join(appData, 'claude-code-sessions', 'acct', 'org');
  const fsp = {
    ...fs.promises,
    readdir: (dir: string, opts?: any) =>
      dir === org ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })) : fs.promises.readdir(dir, opts),
  };
  assert.deepEqual(await createDesktopLineage({ appData: () => appData, fsp }).read(), {});
});

test('sessionOf keeps only a usable record; lineageOf links only known parents', () => {
  assert.equal(sessionOf(null), null);
  assert.equal(sessionOf('x'), null);
  assert.equal(sessionOf({ cliSessionId: 'c' }), null);
  assert.deepEqual(sessionOf({ sessionId: 'local_a', cliSessionId: '', lastAssistantCliSessionId: 7, spawnedFrom: { sessionId: 3 } }), {
    local: 'local_a',
    cli: null,
    parent: null,
    createdAt: 0,
  });
  assert.deepEqual(
    lineageOf([
      { local: 'a', cli: 'A', parent: null, createdAt: 0 },
      { local: 'b', cli: 'B', parent: 'a', createdAt: 1 },
      { local: 'c', cli: 'C', parent: 'z', createdAt: 2 },
      { local: 'e', cli: 'E', parent: 'n', createdAt: 3 },
      { local: 'n', cli: null, parent: null, createdAt: 0 },
    ]),
    { B: { parentId: 'A', createdAt: 1 } },
  );
});

test('main serves the links on claude:desktopLineage from one reader', async (t) => {
  const { register } = require('../electron/app/ipc/desktopLineage.cjs');
  let handler: any;
  const ipcMain = { handle: (channel: string, fn: any) => (assert.equal(channel, 'claude:desktopLineage'), (handler = fn)) };
  register(ipcMain, {}, { read: async () => ({ k: { parentId: 'p', createdAt: 1 } }) });
  assert.deepEqual(await handler(), { k: { parentId: 'p', createdAt: 1 } });
  // its default reader reads Claude desktop under the home folder: an empty one here, never the real one
  const prev = process.env.HOME;
  process.env.HOME = tmp(t);
  t.after(() => (process.env.HOME = prev));
  register(ipcMain, {});
  assert.deepEqual(await handler(), {});
  if (process.platform !== 'darwin') return;
  const appData = path.join(process.env.HOME!, 'Library', 'Application Support', 'Claude');
  session(appData, { sessionId: 'local_p', cliSessionId: 'cli-p' });
  session(appData, { sessionId: 'local_k', cliSessionId: 'cli-k', createdAt: 4, spawnedFrom: { sessionId: 'local_p' } });
  assert.deepEqual(await handler(), { 'cli-k': { parentId: 'cli-p', createdAt: 4 } });
});
