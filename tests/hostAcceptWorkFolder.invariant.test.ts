// The acceptance harnesses start their chats in a folder beside the Host's data folder, never in it (#5614: the Host refuses a chat, a listing or a read in its own data, config and socket folders): no script hands the data folder to a chat as its working folder, and the folder they use is the data folder's parent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
// @ts-ignore: plain ESM without declarations
import { workFolder } from '../scripts/host-accept/workFolder.mjs';

export const GUARDS = ['scripts/'];

test("the working folder is the data folder's parent, whatever the platform's data folder is", () => {
  assert.equal(workFolder({ dataDir: '/Users/me/Library/Application Support/mopilot-host' }), '/Users/me/Library/Application Support');
  assert.equal(workFolder({ dataDir: '/home/me/.local/share/mopilot-host' }), '/home/me/.local/share');
  assert.equal(workFolder({ dataDir: '/tmp/mopilot-host-501' }), '/tmp');
  assert.equal(workFolder({}), undefined, 'a run with no data folder yet names none');
});

test("no script starts a chat, or names a folder to list or read, with the Host's data folder as the folder", () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'scripts', 'tests/fixtures'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => /\.(mjs|cjs|js|ts)$/.test(f) && fs.existsSync(f));
  assert.ok(files.length > 50);
  const bad = files.filter(
    (f) =>
      /\b(cwd|path|folder)\s*:\s*(ctx\.state\.dataDir|state\.dataDir)\b/.test(fs.readFileSync(f, 'utf8')) ||
      /\?\?\s*ctx\.state\.dataDir/.test(fs.readFileSync(f, 'utf8')),
  );
  assert.deepEqual(bad, [], 'use workFolder(ctx.state) (scripts/host-accept/workFolder.mjs)');
});
