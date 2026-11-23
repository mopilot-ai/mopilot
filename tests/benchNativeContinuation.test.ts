// Native continuation focus refusal is a driver setup failure even with a short timeout.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-native-focus-'));
const file = path.join(dir, 'chat.jsonl');
fs.writeFileSync(file, '{}');
let focused = false;
let sent = false;
let deliver = true;
let focusPlan: boolean[] = [];
let advance = (_ms: number) => {};
const keys: number[] = [];
mock.module('../bench/drivers/gui.mjs', {
  namedExports: {
    activate: () => {},
    buttonAt: () => null,
    click: () => {},
    // gui.mjs paste(): puts the text on the clipboard and presses Cmd+V (key 9); the order of keys is what these tests check
    paste: () => {
      keys.push(9);
    },
    focusTextArea: () => (focusPlan.length ? focusPlan.shift() : focused),
    key: (code: number) => {
      keys.push(code);
      if (code === 36 && deliver) sent = true;
    },
    rightClickAt: () => {},
    screenshot: () => {},
    sleep: (ms: number) => advance(ms),
  },
});
mock.module('../bench/drivers/desktop.mjs', {
  namedExports: {
    NO_TRANSCRIPT_MS: 60000,
    approveAccess: () => 0,
    confirmApprovals: () => 0,
    unansweredApprovals: () => [],
    refused: () => false,
    desktopTurn: () => ({ ok: true, file, answer: 'first', steps: 1, wallMs: 1 }),
  },
});
mock.module('../bench/lib/transcript.mjs', {
  namedExports: {
    chatUsage: () => null,
    findTranscript: () => file,
    readTranscript: () => ({ prompts: sent ? 2 : 1, done: true, answer: 'second', steps: 2 }),
    transcriptSetup: () => null,
    transcriptTitle: () => 'own test',
  },
});
const { vendorTurn } = await import('../bench/drivers/mgbDesktop.mjs');
const run = (timeoutS = 0.01) =>
  vendorTurn({ arm: { app: 'Claude', transcripts: 'claude' }, prompts: ['first', 'second'], tag: 'own-test', timeoutS });
test('failed composer focus never clears/pastes/sends and is invalid, not model timeout', () => {
  focused = false;
  sent = false;
  keys.length = 0;
  const r = run();
  assert.equal(r.driverError, true);
  assert.equal(r.timedOut, false);
  assert.match(r.error!, /message 2 never reached/);
  assert.equal(keys.includes(0), false);
  assert.equal(keys.includes(9), false);
  assert.equal(keys.includes(36), false);
});
test('a subsequent attempt with confirmed focus sends and completes normally', (t) => {
  t.mock.method(Date, 'now', () => 0);
  focused = true;
  sent = false;
  keys.length = 0;
  const r = run();
  assert.equal(r.driverError, false);
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'second');
  assert.deepEqual(keys.slice(-4), [0, 51, 9, 36]);
});
test('an arm whose composer is not in the AX tree sends without a focus check (#4114)', (t) => {
  t.mock.method(Date, 'now', () => 0);
  focused = false;
  focusPlan = [];
  deliver = true;
  sent = false;
  keys.length = 0;
  const arm = { app: 'ChatGPT', transcripts: 'codex', composerInTree: false };
  const r = vendorTurn({ arm, prompts: ['first', 'second'], tag: 'own-test', timeoutS: 0.01 });
  assert.equal(r.driverError, false);
  assert.deepEqual(keys.slice(-4), [0, 51, 9, 36]);
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('retry focus failure remains a setup error after an initially undelivered send', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  advance = (ms) => {
    now += ms;
  };
  focusPlan = [true, false];
  deliver = false;
  sent = false;
  keys.length = 0;
  try {
    const r = run(120);
    assert.equal(r.driverError, true);
    assert.equal(r.timedOut, false);
    assert.match(r.error!, /message 2 never reached/);
    assert.equal(keys.filter((k) => k === 36).length, 1);
    assert.equal(focusPlan.length, 0);
  } finally {
    advance = () => {};
    deliver = true;
    focusPlan = [];
  }
});
