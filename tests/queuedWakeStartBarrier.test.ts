// Queued-wake E2E must observe its child admitted before turning failures on, including a parent carrying the same brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { parseAst } from 'rolldown/parseAst';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';
import { hasRunningCodexTurn } from './e2e/fixtures/codex-running-turn.mjs';

const PROMPT = 'Report the schema result SLOW';
function nodes(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  return [node, ...Object.values(node).flatMap(nodes)];
}
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-wake-start-'));
  const beforeCleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const stop of beforeCleanup) await stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const log = path.join(root, 'codex.jsonl');
  fs.writeFileSync(log, '');
  const source = fs.readFileSync('tests/e2e/cuj-queued-wake-removed.spec.ts', 'utf8');
  const predicates = nodes(parseAst(source, { lang: 'ts' })).filter(
    (node) =>
      node.type === 'CallExpression' &&
      node.callee.property?.name === 'poll' &&
      /codexLog|hasRunningCodexTurn/.test(source.slice(node.arguments[0]?.start, node.arguments[0]?.end)),
  );
  assert.equal(predicates.length, 1, 'execute the actual spec admission predicate');
  const predicate = predicates[0].arguments[0];
  const ready = runInNewContext(stripTypeScriptTypes(`(${source.slice(predicate.start, predicate.end)})`), {
    harness: { env: { FAKE_CODEX_LOG: log }, codexLog: () => readJsonLineLog(log) },
    hasRunningCodexTurn,
  });
  return { root, log, ready, beforeCleanup };
}

test('the actual queued-wake barrier rejects the parent request carrying its child brief', (t) => {
  const f = fixture(t);
  const text = `MCPCU start_session ${JSON.stringify({ prompt: PROMPT }).replace(/SLOW/g, 'SL\\u004fW')}`;
  fs.writeFileSync(f.log, JSON.stringify({ method: 'turn/start', params: { input: [{ type: 'text', text }] } }) + '\n');
  assert.equal(f.ready(), false, 'the parent request is not an accepted child turn');
});

test('the actual fake server must accept the child before the spec changes its refusal policy', async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['tests/e2e/fixtures/fake-codex.mjs', 'app-server'], {
    env: { PATH: process.env.PATH, HOME: f.root, CODEX_HOME: f.root, FAKE_CODEX_LOG: f.log, FAKE_CODEX_FAIL: 'turn/start' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map<number, (message: any) => void>();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let stderr = '',
    id = 0;
  child.stderr.on('data', (chunk) => (stderr += chunk));
  f.beforeCleanup.push(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      });
  });
  const call = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error(`fake request timed out: ${stderr}`));
      }, 5000);
      waiting.set(requestId, (message) => {
        clearTimeout(timeout);
        waiting.delete(requestId);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
    });
  const { thread } = await call('thread/start', { cwd: f.root });
  const params = { threadId: thread.id, input: [{ type: 'text', text: PROMPT }] };
  await assert.rejects(call('turn/start', params), /FAKE_CODEX_FAIL/);
  assert.equal(f.ready(), false, 'even a logged child request can be refused');
  fs.writeFileSync(`${f.log}.unfail`, '');
  const carryingParent = await call('thread/start', { cwd: f.root });
  const parentText = `MCPCU start_session ${JSON.stringify({ prompt: PROMPT }).replace(/SLOW/g, 'SL\\u004fW')}`;
  fs.writeFileSync(`${f.log}.hold-next`, '');
  await call('turn/start', { threadId: carryingParent.thread.id, input: [{ type: 'text', text: parentText }] });
  const admittedParent = await call('thread/read', { threadId: carryingParent.thread.id, includeTurns: true });
  assert.equal(admittedParent.thread.turns[0].status, 'inProgress');
  assert.equal(f.ready(), false, 'an admitted parent carrying the escaped brief is still not the child');
  await call('turn/start', params);
  // This ordered RPC is after admission and its synchronous save, independent of stdout/filesystem scheduling.
  await call('thread/read', { threadId: thread.id, includeTurns: true });
  assert.equal(f.ready(), true);
  fs.rmSync(`${f.log}.unfail`);
  const parent = await call('thread/start', { cwd: f.root });
  await assert.rejects(
    call('turn/start', { threadId: parent.thread.id, input: [{ type: 'text', text: 'parent wake' }] }),
    /FAKE_CODEX_FAIL/,
  );
  assert.equal(f.ready(), true, 'refusing a later parent request cannot undo admission of the running child');
});

test('missing, malformed, unrelated and completed snapshots cannot establish a running child', (t) => {
  const f = fixture(t);
  const saved = path.join(f.root, 'codex.jsonl.a.state.json');
  for (const data of ['{', '{}', '[]']) {
    fs.writeFileSync(saved, data);
    assert.equal(hasRunningCodexTurn(f.log, PROMPT), false);
  }
  const state = [{ turns: [{ status: 'inProgress', items: [{ type: 'userMessage', content: [{ type: 'text', text: PROMPT }] }] }] }];
  for (const status of ['completed', 'interrupted']) {
    fs.writeFileSync(saved, JSON.stringify([{ turns: [{ ...state[0].turns[0], status }] }]));
    assert.equal(hasRunningCodexTurn(f.log, PROMPT), false, `${status} cannot satisfy the barrier even with matching input`);
  }
  fs.writeFileSync(path.join(f.root, 'other-log.a.state.json'), JSON.stringify(state));
  assert.equal(hasRunningCodexTurn(f.log, PROMPT), false);
  fs.writeFileSync(saved, JSON.stringify(state));
  assert.equal(hasRunningCodexTurn(f.log, PROMPT), true);
});
