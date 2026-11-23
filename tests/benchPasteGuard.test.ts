// The benchmark VM's vendor-app driver pastes a prompt only when the clipboard still holds it (#4376): gui.paste's copy, read-back, Cmd+V and clear, and the turns that send nothing when other text took the clipboard. child_process is faked.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Call = { cmd: string; input?: string; script?: string };
const calls: Call[] = [];
let front = 'ChatGPT';
let clipboard = '';
/** what another writer (the host's shared clipboard) replaces a copied text with; null leaves it */
let intruder: ((text: string) => string | null) | null = null;

mock.module('node:child_process', {
  exports: {
    execFileSync(file: string, args: string[] = [], opts: { input?: string } = {}) {
      if (file === 'sleep') return '';
      const cmd = args[2];
      const script = args
        .slice(3)
        .filter((_, i) => i % 2 === 1)
        .join('\n');
      if (cmd === 'pbcopy') clipboard = intruder?.(opts.input ?? '') ?? opts.input ?? '';
      if (cmd === 'pbpaste') {
        calls.push({ cmd });
        return clipboard;
      }
      if (cmd !== 'osascript') {
        calls.push({ cmd, input: opts.input });
        return '';
      }
      const want = /if n is not "((?:[^"\\]|\\.)*)"/.exec(script);
      if (want && JSON.parse(`"${want[1]}"`) !== front)
        throw Object.assign(new Error('Command failed'), { status: 1, stderr: `0:212: execution error: ${front} (9001)\n` });
      calls.push({ cmd, script });
      return '';
    },
  },
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-guard-home-'));
process.env.HOME = home;
const { NotFrontmost } = await import('../bench/lib/frontGuard.mjs');
const gui = await import('../bench/drivers/gui.mjs');
const desktop = await import('../bench/drivers/desktop.mjs');
const { vendorTurn } = await import('../bench/drivers/mgbDesktop.mjs');

const ARM = { app: 'ChatGPT', transcripts: 'codex', newChat: 'cmd+n', composer: null };
const CLAUDE = { app: 'Claude', transcripts: 'claude', newChat: 'cmd+n', composer: null };
const keyCodes = () => calls.flatMap((c) => /key code (\d+)/.exec(c.script ?? '')?.[1] ?? []);
const copies = () => calls.filter((c) => c.cmd === 'pbcopy').map((c) => c.input);

beforeEach(() => {
  calls.length = 0;
  front = 'ChatGPT';
  clipboard = '';
  intruder = null;
});

test('gui.paste: the text goes on the clipboard just before Cmd+V, is read back, and is cleared afterwards', () => {
  gui.activate('ChatGPT');
  calls.length = 0;
  gui.paste('hello\n');
  assert.deepEqual(
    calls.map((c) => (c.cmd === 'osascript' ? `key ${keyCodes()[0]}` : c.cmd)),
    ['pbcopy', 'pbpaste', 'key 9', 'pbcopy'],
  );
  assert.deepEqual(copies(), ['hello\n', '']);
  assert.equal(clipboard, '');
});

test('gui.paste: a clipboard that holds other text is not pasted, and is still cleared', () => {
  gui.activate('ChatGPT');
  intruder = (text) => (text ? '[{"message":"the hosted CLI ended"}]' : null);
  assert.throws(
    () => gui.paste('Thanks. Now issue the refunds.'),
    (e: any) => e instanceof gui.ClipboardChanged && e.code === 'clipboard_changed',
  );
  assert.deepEqual(keyCodes(), [], 'no Cmd+V');
  assert.equal(clipboard, '');
  // another app in front at the paste: the guard's refusal passes through, and the clipboard is cleared too
  intruder = null;
  front = 'Finder';
  assert.throws(() => gui.paste('p'), NotFrontmost);
  assert.equal(clipboard, '');
});

test('desktopTurn: a changed clipboard stops the turn before anything is pasted or sent', () => {
  intruder = (text) => (text ? 'someone else copied this' : null);
  const r: any = desktop.desktopTurn({ arm: ARM, prompt: 'hello (ref t5)', tag: 't5', timeoutS: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.notSent, true);
  assert.equal(r.front, 'the clipboard changed');
  // Esc, Cmd+N, Cmd+A, Delete: no Cmd+V and no Return
  assert.deepEqual(keyCodes(), ['53', '45', '0', '51']);
});

test("vendorTurn: a follow-up whose clipboard changed is never sent, and the run is the driver's error", () => {
  front = 'Claude';
  const dir = path.join(home, '.claude/projects/p');
  fs.mkdirSync(dir, { recursive: true });
  const add = (d: unknown) => fs.appendFileSync(path.join(dir, 'tagK.jsonl'), `${JSON.stringify(d)}\n`);
  add({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'one (ref tagK)' }] } });
  add({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
  let copied = 0;
  intruder = (text) => (text && ++copied > 1 ? 'someone else copied this' : null);
  let t = 0;
  const realNow = Date.now;
  Date.now = () => (t += 30_000);
  try {
    const r: any = vendorTurn({ arm: CLAUDE, prompts: ['one (ref tagK)', 'two'], tag: 'tagK', timeoutS: 600 });
    assert.equal(r.driverError, true);
    assert.equal(keyCodes().filter((c) => c === '36').length, 1, 'only the first message was sent');
  } finally {
    Date.now = realNow;
  }
});
