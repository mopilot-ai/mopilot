// The real-login bench probes' protocol and ownership evidence: a stdio server gets the actual answers, and a lost source cannot supply the local inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localContinuation } from '../bench/host-stream/local-continuation.mjs';
import { LINK } from '../bench/host-stream/elicitation-server.mjs';
import { steps, selectSteps } from '../bench/host-stream2-real.mjs';

test('the stdio MCP probe receives form and URL replies and records them independently of model prose', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-probe-'));
  const evidence = path.join(dir, 'answers.json');
  const entry = path.join(dir, 'server.mjs');
  fs.symlinkSync(path.resolve('bench/host-stream/elicitation-server.mjs'), entry);
  const child = spawn(process.execPath, [entry, evidence], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const messages: any[] = [];
  const ended = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 10_000);
  try {
    const result = new Promise<any>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('MCP server exited before its tool result.')));
      lines.on('line', (line) => {
        const message = JSON.parse(line);
        messages.push(message);
        if (message.method === 'elicitation/create') {
          if (message.params.mode === 'form') send({ id: message.id, result: { action: 'accept', content: { word: 'unique-test-word' } } });
          else {
            assert.equal(message.params.url, LINK);
            send({ id: message.id, result: { action: 'cancel' } });
          }
        }
        if (message.id === 3) resolve(message.result);
      });
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {}, url: {} } } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'tools/call', params: { name: 'probe', arguments: {} } });
    const reply = await result;
    assert.deepEqual(JSON.parse(reply.content[0].text), {
      form: { action: 'accept', content: { word: 'unique-test-word' } },
      link: { action: 'cancel' },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(evidence, 'utf8')), JSON.parse(reply.content[0].text));
    assert.equal(messages.find((m) => m.id === 1).result.protocolVersion, '2025-11-25');
    assert.equal(messages.find((m) => m.id === 2).result.tools[0].name, 'probe');
  } finally {
    child.stdin.end();
    await ended;
    clearTimeout(deadline);
    lines.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an offline source moves through production local ownership and inbox, preserving a tool step and consuming only after send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-probe-'));
  try {
    const items = [
      { t: 'user', turnId: 't', text: 'Remember secret-123.' },
      {
        t: 'event',
        family: 'acp',
        event: {
          kind: 'update',
          turnId: 't',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'cmd',
            kind: 'execute',
            title: 'echo handoff-ok',
            status: 'completed',
            rawInput: { command: 'echo handoff-ok' },
          },
        },
      },
      { t: 'assistant', turnId: 't', text: 'ended', stopReason: 'end_turn' },
    ];
    const local = await localContinuation({ dir, chatId: 'claude:probe', harness: 'claude', items, rev: 3 });
    assert.match(local.text, /secret-123/);
    assert.match(local.text, /Ran `echo handoff-ok`/);
    assert.match(local.text, /ended/);
    assert.equal(local.pending()?.text, local.text);
    local.done();
    assert.equal(local.pending(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('family selection retains R7 for either source and keeps the Claude MCP probe out of Codex-only runs', () => {
  assert.ok(steps({ only: 'claude' }).some((s) => s.id === 'R6'));
  assert.ok(!steps({ only: 'codex' }).some((s) => s.id === 'R6'));
  for (const only of ['claude', 'codex']) assert.ok(steps({ only }).some((s) => s.id === 'R7'));
});

test('probe selection rejects a typo, empty value and incompatible family before setup can pass', () => {
  for (const requested of ['', 'R66', 'R6,', 'A1']) assert.throws(() => selectSteps({ requested }));
  assert.throws(() => selectSteps({ only: 'codex', requested: 'R6' }));
  assert.throws(() => selectSteps({ only: 'other' }));
  assert.deepEqual(
    selectSteps({ only: 'claude', requested: 'R4,R6' }).map((s) => s.id),
    ['A1', 'A2', 'A3', 'A4', 'A5', 'R4', 'R6'],
  );
});

test('the bench entrypoint follows a symlink and rejects missing VM arguments rather than silently succeeding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-entry-'));
  try {
    const entry = path.join(dir, 'bench.mjs');
    fs.symlinkSync(path.resolve('bench/host-stream2-real.mjs'), entry);
    const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Missing value for --vm/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
