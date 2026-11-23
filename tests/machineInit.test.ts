// /init on a machine's folder (src/lib/initFolder.ts, src/harness/polyfills/init.ts machineInit): the instruction files are read there through the Host's read-only `fs.read`, a file that is not there is absent and any other failure is the person's to read, and the pointer line an accepted offer asks for goes with the command, not into a file written from here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { useFakeNative } from './support/ports/native.ts';
import { localInitFolder, machineInitFolder } from '../src/lib/initFolder.ts';
import { initPrompt, machineInit, planInit, pointerAsk } from '../src/harness/polyfills/init.ts';

const asked: any[][] = [];
let reply: (q: any) => any = () => ({ error: { code: 'directory_missing', message: 'gone' } });
const bridge = (t: { after: (fn: () => void) => void }, fs: object = {}) =>
  useFakeNative(t, { host: { fsRead: (id: string, q: any) => (asked.push([id, q]), reply(q)) }, fs });

test('A: a machine’s file is read there, by its full path and a small bound; text is its text, and a file that is not text is there with none', async (t) => {
  bridge(t);
  asked.length = 0;
  const folder = machineInitFolder('m1', '/srv/app/');
  reply = (q) => ({
    value: q.path.endsWith('AGENTS.md') ? { kind: 'text', text: '# A', size: 3, truncated: false } : { kind: 'binary', size: 9 },
  });
  assert.equal(folder.path('AGENTS.md'), '/srv/app/AGENTS.md');
  assert.equal(await folder.text('AGENTS.md'), '# A');
  assert.equal(await folder.text('CLAUDE.md'), '');
  assert.deepEqual(await Promise.all([folder.exists('AGENTS.md'), folder.exists('CLAUDE.md')]), [true, true]);
  assert.deepEqual(asked[0], ['m1', { path: '/srv/app/AGENTS.md', limit: 65536 }]);
});

test('B: a path that does not exist, or is not a file, is absent; any other refusal is an error, so /init never plans from a guess', async (t) => {
  bridge(t);
  const folder = machineInitFolder('m1', '/srv/app');
  for (const code of ['directory_missing', 'not_a_file']) {
    reply = () => ({ error: { code, message: 'x' } });
    assert.equal(await folder.text('AGENTS.md'), null, code);
    assert.equal(await folder.exists('AGENTS.md'), false, code);
  }
  for (const error of [
    { code: 'read_timed_out', message: 'The machine took too long to read that.' },
    { code: 'outside_roots', message: 'outside' },
    { message: 'no code' },
  ]) {
    reply = () => ({ error });
    await assert.rejects(folder.exists('AGENTS.md'), { message: error.message });
  }
});

test('A: a folder on this Mac is read by this Mac’s own file calls, and nothing goes to a machine', async (t) => {
  const reads: string[] = [];
  bridge(t, {
    exists: async (p: string) => (reads.push(`exists ${p}`), p.endsWith('AGENTS.md')),
    readText: async (p: string) => (reads.push(`read ${p}`), '# C'),
  });
  asked.length = 0;
  const folder = localInitFolder('/proj/');
  assert.equal(folder.path('CLAUDE.md'), '/proj/CLAUDE.md');
  assert.equal(await folder.exists('AGENTS.md'), true);
  assert.equal(await folder.text('CLAUDE.md'), '# C');
  assert.deepEqual(reads, ['exists /proj/AGENTS.md', 'read /proj/CLAUDE.md']);
  assert.deepEqual(asked, []);
});

test('W: from a machine, an accepted offer is one more instruction of the command; declined, or with nothing to offer, the command is as typed', () => {
  const claude = planInit('claude', { agents: true, claude: true })!;
  assert.equal(pointerAsk({ ...claude, offer: claude.offer! }), 'Finally, add this line at the end of CLAUDE.md, once: @AGENTS.md');
  assert.equal(machineInit(claude, '/init extra', true), '/init extra Finally, add this line at the end of CLAUDE.md, once: @AGENTS.md');
  assert.equal(machineInit(claude, '/init', false), '/init');
  assert.equal(machineInit(planInit('claude', { agents: false, claude: true }), '/init', true), '/init');
  assert.equal(machineInit(null, '/init', true), '/init');
  // Codex's own prompt says it the same way
  const codex = planInit('codex', { agents: false, claude: true })!;
  assert.equal(
    initPrompt(codex, true),
    `${codex.prompt} Finally, add this line at the end of AGENTS.md, once: Also follow the instructions in CLAUDE.md.`,
  );
  assert.equal(initPrompt(codex, false), codex.prompt);
});
