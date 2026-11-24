// The folders no request may name (host/src/hostFs.mjs `denied`, R2b of #5576): the Host's own data and config folders and its socket's, wherever the roots reach, by real path, so a client that may read files cannot read the token beside the socket.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore
import { createHostFiles } from '../host/src/hostFiles.mjs';
// @ts-ignore
import { createHostSearch } from '../host/src/hostSearch.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-denied-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, 'home');
const data = path.join(home, 'Library', 'Application Support', 'mopilot-host');
const config = path.join(home, '.config', 'mopilot-host');
const agents = path.join(home, 'Library', 'LaunchAgents');
const work = path.join(home, 'work');
const missing = path.join(home, 'no', 'such', 'unit');
for (const d of [data, config, agents, work]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(data, 'host.sock.token'), 'SECRET');
fs.writeFileSync(path.join(config, 'pairing.json'), '{}');
fs.writeFileSync(path.join(agents, 'ai.mopilot.host.plist'), '<plist/>');
fs.writeFileSync(path.join(work, 'a.txt'), 'fine');
fs.symlinkSync(data, path.join(work, 'link-to-data'));
const hostFs = createHostFs({ roots: [home], denied: [data, config, agents, missing] });
const refused = { code: 'outside_roots' };

test('a denied folder and everything in it is refused to resolve, list, read in or run a chat in, by real path', async () => {
  for (const p of [
    data,
    config,
    agents,
    path.join(data, 'host.sock.token'),
    path.join(work, 'link-to-data'),
    path.join(work, '..', 'Library', 'Application Support', 'mopilot-host'),
    path.join(work, 'link-to-data', 'host.sock.token'),
  ]) {
    await assert.rejects(hostFs.resolve(p), refused, p);
    await assert.rejects(hostFs.requireDirectory(p), refused, p);
  }
  await assert.rejects(hostFs.existingDirectory(data), refused, 'a chat may not run there');
  await assert.rejects(hostFs.existingDirectory(path.join(config)), refused);
  await assert.rejects(hostFiles().read({ path: path.join(data, 'host.sock.token') }), refused);
  await assert.rejects(hostFiles().read({ path: path.join(work, 'link-to-data', 'host.sock.token') }), refused);
  await assert.rejects(hostFiles().tree({ path: data }), refused);
  // the folder next to them and the home stay open
  assert.equal(await hostFs.resolve(work), work);
  assert.equal(await hostFs.existingDirectory(home), home);
  assert.equal((await hostFiles().read({ path: path.join(work, 'a.txt') })).text, 'fine');
});

test('a case-folded spelling is refused where the file system folds case', async (t) => {
  if (process.platform !== 'darwin') return t.skip('case-sensitive here');
  await assert.rejects(hostFs.resolve(path.join(home, 'LIBRARY', 'application support', 'MOPILOT-HOST', 'host.sock.token')), refused);
});

test('a listing, a tree and a search below a folder that holds a denied one leave it out', async () => {
  const names = (await hostFs.list({ path: home, hidden: true })).entries.map((e: any) => e.name);
  assert.ok(names.includes('work') && names.includes('.config') && names.includes('Library'));
  const lib = (await hostFs.list({ path: path.join(home, 'Library'), hidden: true })).entries.map((e: any) => e.name);
  assert.ok(!lib.includes('LaunchAgents'), 'the denied folder is not listed');
  assert.ok(lib.includes('Application Support'), 'its parent is');
  const support = (await hostFs.list({ path: path.join(home, 'Library', 'Application Support'), hidden: true })).entries.map(
    (e: any) => e.name,
  );
  assert.deepEqual(support, []);
  const tree = await hostFiles().tree({ path: path.join(home, 'Library') });
  assert.deepEqual(
    tree.entries.map((e: any) => e.name),
    ['Application Support'],
  );
  const rg = async () => ({
    ok: true,
    stdout: [
      'work/a.txt',
      'Library/LaunchAgents/ai.mopilot.host.plist',
      'LIBRARY/launchagents/x',
      'Library/Application Support/mopilot-host/host.sock.token',
      'Library/Other/ok.txt',
    ].join('\0'),
    spawnFailed: false,
  });
  const found = await createHostSearch({ hostFs, rg: rg as any }).search({ path: home, query: '', limit: 50 });
  assert.deepEqual(found.files.sort(), ['Library/Other/ok.txt', 'work/a.txt']);
});

test('no denied folder is no rule, and one that does not exist yet is refused where it will be', async () => {
  const open = createHostFs({ roots: [home] });
  assert.equal(await open.resolve(data), data);
  assert.deepEqual(await open.deniedUnder(home), []);
  fs.mkdirSync(missing, { recursive: true });
  await assert.rejects(hostFs.resolve(missing), refused);
});

function hostFiles() {
  return createHostFiles({ hostFs });
}

test("the Host's own folders are its data, config and socket folders and the login-item places", async () => {
  const { hostFolders } = await import('../host/src/hostFs.mjs');
  assert.deepEqual(hostFolders({ dataDir: '/d', configDir: '/c', socketPath: '/s/host.sock' }, '/h'), [
    '/d',
    '/c',
    '/s',
    '/h/Library/LaunchAgents',
    '/h/.config/systemd/user',
    '/h/.mopilot-host',
  ]);
  assert.equal(hostFolders({ dataDir: '/d', configDir: '/c', socketPath: '/s/host.sock' }).length, 6);
});

test('writes are held to the same folders: a clone or a worktree may not be made in one, by a name that does not exist yet', async () => {
  const { createHostGit } = await import('../host/src/hostGit.mjs');
  const repo = path.join(work, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = createHostGit({ hostFs: createHostFs({ roots: [home], denied: [data, config, agents, path.join(work, 'repo.worktrees')] }) });
  await assert.rejects(git.clone({ key: 'k1', url: 'https://example.invalid/x.git', dest: agents }), refused, 'the folder itself');
  await assert.rejects(
    git.clone({ key: 'k2', url: 'https://example.invalid/x.git', dest: path.join(data, 'sub') }),
    refused,
    'one below it',
  );
  await assert.rejects(
    git.clone({ key: 'k3', url: 'https://example.invalid/x.git', dest: path.join(work, 'link-to-data', 'sub') }),
    refused,
    'through a link',
  );
  await assert.rejects(git.worktree({ key: 'w1', repo, branch: 'topic', from: 'main' }), refused, 'the worktree folder of a repository');
  await assert.rejects(git.inspect({ path: data }), refused);
  await assert.rejects(git.worktree({ key: 'w2', repo: data, branch: 'topic' }), refused);
  const { createHostWrite } = await import('../host/src/hostWrite.mjs');
  const write = createHostWrite({ hostFs });
  await assert.rejects(write.switchBranch({ path: data, branch: 'x' }, 'desktop'), refused, "a folder write in the Host's own folder");
  await assert.rejects(write.switchBranch({ path: path.join(work, 'link-to-data'), branch: 'x' }, 'desktop'), refused);
});

test("a name that is not there says what one that is says: refused in the Host's own folders and outside the roots, missing only where the answer tells nothing", async () => {
  const gone = [
    path.join(data, 'nothing', 'here'),
    path.join(work, 'link-to-data', 'nothing'),
    path.join(config, 'x.json'),
    path.join(agents, 'new.plist'),
  ];
  for (const p of gone) {
    await assert.rejects(hostFs.resolve(p), refused, p);
    await assert.rejects(hostFs.existingDirectory(p), refused, p);
    await assert.rejects(hostFs.requireDirectory(p), refused, p);
    await assert.rejects(hostFiles().read({ path: p }), refused, p);
  }
  // outside the roots, present or missing, is one answer
  const outside = fs.mkdtempSync(path.join(base, 'outside-'));
  await assert.rejects(hostFs.resolve(outside), refused);
  await assert.rejects(hostFs.resolve(path.join(outside, 'missing')), refused);
  // where nothing is refused, a missing folder is missing
  await assert.rejects(hostFs.resolve(path.join(work, 'nothing')), { code: 'directory_missing' });
  await assert.rejects(hostFs.existingDirectory(path.join(work, 'nothing', 'deeper')), { code: 'directory_missing' });
  await assert.rejects(hostFs.existingDirectory('relative/path'), { code: 'invalid_path' });
});
