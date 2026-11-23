// electron/harness/latestVersion.cjs: the newest version from npm's registry or Homebrew, kept 6 hours (a failure 15
// minutes, the last good answer kept meanwhile), one request in flight per package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLatest, parseVersion, OK_MS, FAIL_MS } = require('../electron/harness/latestVersion.cjs');

function setup() {
  let t = 0;
  const asked: string[] = [];
  let answer: () => Promise<unknown> = async () => ({ version: '2.1.302' });
  let brewAnswer: () => Promise<unknown> = async () => ({ formulae: [{ versions: { stable: '0.25.2' } }], casks: [] });
  const latest = createLatest({
    fetchJson: (url: string, timeout: number) => (asked.push(`${url} ${timeout}`), answer()),
    brewInfo: (brew: string, name: string, cask: boolean, timeout: number) => (
      asked.push(`${brew} ${name} ${cask} ${timeout}`), brewAnswer()
    ),
    now: () => t,
  });
  return {
    latest,
    asked,
    at: (ms: number) => (t = ms),
    answer: (fn: () => Promise<unknown>) => (answer = fn),
    brew: (fn: () => Promise<unknown>) => (brewAnswer = fn),
  };
}

test('versions are read from what a CLI or a registry printed', () => {
  assert.equal(parseVersion('2.1.302 (Claude Code)'), '2.1.302');
  assert.equal(parseVersion('codex-cli 0.163.0-alpha.10.2'), '0.163.0-alpha.10.2');
  assert.equal(parseVersion('v0.21.0.'), '0.21.0');
  assert.equal(parseVersion('kimi, version 1.4'), '1.4');
  assert.equal(parseVersion('no version here'), null);
  assert.equal(parseVersion(undefined), null);
});

test("npm's latest is asked once while fresh, by everyone waiting at once, and again after 6 hours", async () => {
  const s = setup();
  const [a, b] = await Promise.all([s.latest.npm('@anthropic-ai/claude-code'), s.latest.npm('@anthropic-ai/claude-code')]);
  assert.equal(a, '2.1.302');
  assert.equal(b, '2.1.302');
  assert.deepEqual(s.asked, ['https://registry.npmjs.org/@anthropic-ai/claude-code/latest 8000']);
  s.at(OK_MS - 1);
  await s.latest.npm('@anthropic-ai/claude-code');
  assert.equal(s.asked.length, 1);
  s.at(OK_MS);
  s.answer(async () => ({ version: 'v2.1.303' }));
  assert.equal(await s.latest.npm('@anthropic-ai/claude-code'), '2.1.303');
  assert.equal(s.asked.length, 2);
});

test('a failure keeps the last good answer for 15 minutes; a first failure is no answer; a bad answer is a failure', async () => {
  const s = setup();
  await s.latest.npm('opencode-ai');
  s.at(OK_MS);
  s.answer(async () => Promise.reject(new Error('offline')));
  assert.equal(await s.latest.npm('opencode-ai'), '2.1.302');
  s.at(OK_MS + FAIL_MS - 1);
  assert.equal(await s.latest.npm('opencode-ai'), '2.1.302');
  assert.equal(s.asked.length, 2, 'not asked again while the failure is fresh');
  s.at(OK_MS + FAIL_MS);
  for (const bad of [{ version: 7 }, null, {}, { version: 'latest' }]) {
    s.answer(async () => bad);
    s.at(s.asked.length * 10 * OK_MS);
    assert.equal(await s.latest.npm('opencode-ai'), '2.1.302', JSON.stringify(bad));
  }
  assert.equal(await s.latest.npm('never-answered'), null);
});

test("Homebrew: a formula's stable version, a cask's version before its build, by the brew that owns it", async () => {
  const s = setup();
  assert.equal(await s.latest.brew('/opt/homebrew/bin/brew', 'qwen-code', false), '0.25.2');
  s.brew(async () => ({ casks: [{ version: '2.1.302,abc123' }] }));
  assert.equal(await s.latest.brew('/opt/homebrew/bin/brew', 'claude-code', true), '2.1.302');
  assert.deepEqual(s.asked, ['/opt/homebrew/bin/brew qwen-code false 15000', '/opt/homebrew/bin/brew claude-code true 15000']);
  s.brew(async () => ({}));
  assert.equal(await s.latest.brew('/b', 'x', false), null);
  assert.equal(await s.latest.brew('/b', 'y', true), null);
});

test('forgetting an answer asks again next time, unless a request is in flight; keys name the channel', async () => {
  const s = setup();
  await s.latest.npm('p');
  s.latest.forget('npm:p');
  await s.latest.npm('p');
  assert.equal(s.asked.length, 2);
  let release!: () => void;
  s.answer(() => new Promise((r) => (release = () => r({ version: '3.0.0' }))));
  s.latest.forget('npm:p');
  const pending = s.latest.npm('p');
  s.latest.forget('npm:p');
  release();
  assert.equal(await pending, '3.0.0');
  assert.equal(await s.latest.npm('p'), '3.0.0', 'the in-flight answer was kept');
  s.latest.forget('npm:nothing');
  assert.equal(s.latest.keyOf('npm', 'p', false), 'npm:p');
  assert.equal(s.latest.keyOf('self', 'p', false), 'npm:p');
  assert.equal(s.latest.keyOf('brew', 'codex', true), 'brew:cask:codex');
  assert.equal(s.latest.keyOf('brew', 'qwen-code', false), 'brew:qwen-code');
});

test('defaults: the real clock and npm registry', async () => {
  const urls: string[] = [];
  const latest = createLatest({ fetchJson: async (u: string) => (urls.push(u), { version: '1.0.0' }), brewInfo: async () => ({}) });
  assert.equal(await latest.npm('x'), '1.0.0');
  assert.deepEqual(urls, ['https://registry.npmjs.org/x/latest']);
});
