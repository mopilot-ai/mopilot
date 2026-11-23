// The scripted GitHub CLI must satisfy the production PR reader used by every harness's PR/CI journey.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { relatedSpecs, reverseGraph } from '../scripts/related-tests.mjs';
const require = createRequire(import.meta.url);
const { readPullRequest } = require('../electron/platform/prGithub.cjs');
const cli = fileURLToPath(new URL('./e2e/fixtures/fake-gh.mjs', import.meta.url));
const runFile = promisify(execFile);
const url = 'https://github.com/acme/demo/pull/7';
async function run(args: string[], log?: string) {
  try {
    const result = await runFile(process.execPath, [cli, ...args], {
      env: { ...process.env, FAKE_GH_PR_URL: url, ...(log ? { FAKE_GH_LOG: log } : {}) },
    });
    return { ok: true, ...result };
  } catch (error: any) {
    return { ok: false, stdout: error.stdout, stderr: error.stderr };
  }
}

test('actual fake GitHub CLI response passes the production reader and exposes failing CI', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-gh-contract-'));
  const log = path.join(dir, 'argv.jsonl');
  const pr = await readPullRequest((_command: string, args: string[]) => run(args, log), dir, url, true);
  assert.equal(pr.headRefName, 'fix/parser');
  assert.equal(pr.baseRefName, 'main');
  assert.equal(pr.failed, 1);
  assert.equal(pr.pending, 0);
  assert.ok(pr.events.some((event: any) => event.text === 'Failing check: unit-tests'));
  assert.ok((await readFile(log, 'utf8')).includes('headRefName,baseRefName'));
});

test('scripted GitHub commands retain their search, diff, check and not-found outcomes', async () => {
  assert.match((await run(['auth', 'status'])).stdout, /Logged in/);
  assert.equal(JSON.parse((await run(['api', 'user'])).stdout).login, 'octo');
  assert.deepEqual(JSON.parse((await run(['api', 'repos/acme/demo/comments'])).stdout), [[]]);
  assert.equal(JSON.parse((await run(['search', 'prs', '--author=@me'])).stdout)[0].url, url);
  assert.deepEqual(JSON.parse((await run(['search', 'prs'])).stdout), []);
  assert.match((await run(['pr', 'diff', url])).stdout, /diff --git/);
  assert.equal(JSON.parse((await run(['pr', 'checks', url])).stdout)[0].state, 'FAILURE');
  assert.equal((await run(['pr', 'view'])).ok, false);
  assert.equal((await run(['pr', 'view', '--json', 'url'])).ok, false);
  assert.equal((await run(['pr', 'view', url])).ok, true);
  assert.equal((await run(['unknown'])).stdout, '\n');
});

test('the PR journey is selected when its status renderer changes', () => {
  assert.ok(relatedSpecs(['src/components/thread/PrMonitor.tsx'], reverseGraph()).includes('tests/e2e/cuj-pr-and-ci.spec.ts'));
});
