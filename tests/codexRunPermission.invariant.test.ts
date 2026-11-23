// Every Codex request that can start a model run on a thread says how that run gets the chat's permission: a resumed
// thread falls back to Codex's default sandbox, so a run on the thread's own settings needs it applied first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runsOnThreadSettings } = require('../electron/harness/codexLeases.cjs');
const { turnParams } = require('../electron/harness/codexParams.cjs');

const ROOT = path.join(import.meta.dirname, '..');

/**
 * How each run-starting request gets the chat's permission. `applied`: through codex:leased / startGoal (runsOnThreadSettings);
 * `voice`: startVoice applies it before thread/realtime/start (tests/voiceAccess.test.ts); `unsent`: MoPilot never
 * sends it, so a first use must be classified again.
 */
const HOW = {
  'thread/start': 'carries its own approval policy and sandbox (a new thread)',
  'turn/start': 'carries its own approval policy and sandbox',
  'turn/steer': 'joins the running turn and its settings',
  'thread/compact/start': 'summarizes the thread without tools',
  'review/start': 'applied',
  'thread/goal/set': 'applied',
  'thread/realtime/start': 'voice',
  'thread/queue/start': 'unsent',
} as const;

/** The requests in the generated protocol that start something on a thread: a new one must be added to HOW. */
function runStarters() {
  const text = fs.readFileSync(path.join(ROOT, 'src/protocol/ClientRequest.ts'), 'utf8');
  const methods = new Set([...text.matchAll(/"method": "((?:turn|review|thread)\/[A-Za-z/]+)"/g)].map((m) => m[1]));
  return [...methods].filter((m) => /(start|steer)$/.test(m) || m === 'thread/goal/set').sort();
}

const sources = (dir: string): string[] =>
  fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? sources(path.join(dir, e.name)) : /\.(c?js|mjs|tsx?)$/.test(e.name) ? [path.join(dir, e.name)] : [],
    );

test('I: every Codex request that can start a run on a thread is classified by how it gets the chat permission', () => {
  assert.deepEqual(runStarters(), Object.keys(HOW).sort());
});

test("I: the requests that run on the thread's own settings are the ones codex:leased applies the permission for", () => {
  for (const [method, how] of Object.entries(HOW))
    assert.equal(runsOnThreadSettings(method, { threadId: 't', status: 'active' }), how === 'applied', method);
  // a pause carries nothing on
  assert.equal(runsOnThreadSettings('thread/goal/set', { threadId: 't', status: 'paused' }), false);
  const p = turnParams('t', 'c', { text: 'x', opts: {} }, { permission: 'full-access' }, '/w');
  assert.deepEqual([p.approvalPolicy, p.sandboxPolicy], ['never', { type: 'dangerFullAccess' }]);
});

test('I: a request MoPilot never sends stays unsent until it is classified', () => {
  const unsent = Object.entries(HOW)
    .filter(([, how]) => how === 'unsent')
    .map(([m]) => m);
  for (const file of ['electron', 'shared', 'src'].flatMap(sources).filter((f) => !f.startsWith(path.join('src', 'protocol')))) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const method of unsent) assert.ok(!text.includes(`'${method}'`) && !text.includes(`"${method}"`), `${file} sends ${method}`);
  }
});
