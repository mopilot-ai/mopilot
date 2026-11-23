// The name a Claude Code chat was given, apart from the title its CLI writes for itself (electron/harness/claude/userTitle.cjs):
// the SDK's getSessionInfo counts the CLI's `ai-title` as `customTitle`, so a new chat looked named within seconds and
// the title MoPilot generated was never saved or shown (the sidebar kept the first words of the message).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-user-title-'));
process.env.CLAUDE_CONFIG_DIR = root;
const require = createRequire(import.meta.url);
const { createUserTitle } = require('../electron/harness/claude/userTitle.cjs');
const { createRename } = require('../electron/harness/claude/rename.cjs');
const { findTranscript } = require('../electron/harness/claude/transcripts.cjs');
const sdk = () => import('@anthropic-ai/claude-agent-sdk');
const userTitle = createUserTitle(findTranscript);

const proj = path.join(root, 'projects', '-tmp-x');
fs.mkdirSync(proj, { recursive: true });
let n = 0;
const line = (o: object) => `${JSON.stringify(o)}\n`;

/** A transcript: its first prompt, then `extra` lines. */
function session(extra: string[] = [], pad = 0) {
  const id = `11111111-2222-4333-8444-${String(++n).padStart(12, '0')}`;
  const file = path.join(proj, `${id}.jsonl`);
  const turn = (i: number, text: string) =>
    line({
      type: i ? 'assistant' : 'user',
      sessionId: id,
      cwd: '/tmp/x',
      uuid: `u${i}`,
      timestamp: '2026-10-21T00:00:00Z',
      message: { role: i ? 'assistant' : 'user', content: text },
    });
  fs.writeFileSync(file, turn(0, 'first prompt') + extra.join(''));
  for (let i = 1; i <= pad; i++) fs.appendFileSync(file, turn(i, 'x'.repeat(1000)));
  return { id, file, sidecar: path.join(proj, id, 'custom-title.json') };
}

test("the CLI's own title is not a name: the SDK reports it as customTitle, the reader does not", async () => {
  const s = session([line({ type: 'ai-title', aiTitle: 'Odd pasted image', sessionId: 'x' })]);
  // the external assumption this reader exists for
  assert.equal((await (await sdk()).getSessionInfo(s.id))?.customTitle, 'Odd pasted image');
  assert.equal(await userTitle(s.id), null);
});

test('a name given by the user, /rename or MoPilot is read; the last one wins', async () => {
  const s = session([
    line({ type: 'custom-title', customTitle: ' First ', sessionId: 'x' }),
    line({ type: 'ai-title', aiTitle: 'CLI title', sessionId: 'x' }),
    line({ type: 'custom-title', customTitle: 'Second', sessionId: 'x' }),
    line({ type: 'custom-title', customTitle: '  ', sessionId: 'x' }),
    line({ type: 'custom-title', customTitle: 7, sessionId: 'x' }),
    line({ type: 'agent-name', customTitle: 'not a title line', sessionId: 'x' }),
  ]);
  assert.equal(await userTitle(s.id), 'Second');
  const rename = createRename(sdk, findTranscript, () => null);
  await rename(s.id, 'Renamed');
  assert.equal(await userTitle(s.id), 'Renamed');
});

test('a chat that has no transcript yet has no name', async () => {
  assert.equal(await userTitle('99999999-2222-4333-8444-000000000000'), null);
});

test('a name past the first and last 64 KB is read from the sidecar; one in the head of a long transcript from the head', async () => {
  const sidecarOnly = session([], 200);
  fs.mkdirSync(path.dirname(sidecarOnly.sidecar), { recursive: true });
  fs.writeFileSync(sidecarOnly.sidecar, JSON.stringify({ customTitle: ' Kept ' }));
  assert.equal(await userTitle(sidecarOnly.id), 'Kept');

  const head = session([line({ type: 'custom-title', customTitle: 'In the head', sessionId: 'x' })], 200);
  assert.ok(fs.statSync(head.file).size > 128 * 1024);
  assert.equal(await userTitle(head.id), 'In the head');

  // a line the 64 KB window cuts in half is skipped, not taken for a name
  const cut = session([], 200);
  const body = fs.readFileSync(cut.file, 'utf8');
  const half = line({ type: 'custom-title', customTitle: 'Half', sessionId: 'x' });
  fs.writeFileSync(cut.file, `${'y'.repeat(64 * 1024 - half.length / 2)}${half}${body}`);
  assert.equal(await userTitle(cut.id), null);
});

test('an empty or unreadable sidecar is not "no name"', async () => {
  const empty = session();
  fs.mkdirSync(path.dirname(empty.sidecar), { recursive: true });
  fs.writeFileSync(empty.sidecar, JSON.stringify({ customTitle: '  ' }));
  assert.equal(await userTitle(empty.id), null);
  fs.writeFileSync(empty.sidecar, JSON.stringify(null));
  assert.equal(await userTitle(empty.id), null);
  fs.writeFileSync(empty.sidecar, '{ broken');
  await assert.rejects(userTitle(empty.id), SyntaxError);
});
