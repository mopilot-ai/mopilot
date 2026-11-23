// `host.commands` (#4915): the slash commands and skills an agent on a machine offers for a folder. The shaping every end shares (hostCommandsWire), what each agent's own list becomes (hostCommands), the feature only a Host with a source offers (offeredFeatures), and the method over the real protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { COMMANDS_MAX, commandEntry, readCommands } from '../shared/host/hostCommandsWire.mjs';
// @ts-ignore
import { claudeEntries, codexEntries, createHostCommands } from '../host/src/hostCommands.mjs';
// @ts-ignore
import commandsMethod from '../host/src/methods/commands.mjs';
// @ts-ignore
import { offeredFeatures } from '../host/src/offeredFeatures.mjs';
// @ts-ignore
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';

test('an entry keeps the name without its trigger, bounds its words, and says what the composer inserts', () => {
  assert.deepEqual(commandEntry({ name: 'compact', description: ' Free up context ', hint: '[focus]' }), {
    name: 'compact',
    description: 'Free up context',
    hint: '[focus]',
    kind: 'command',
    insert: '/compact ',
  });
  assert.deepEqual(commandEntry({ name: 'review', kind: 'skill', insert: '$review' }), {
    name: 'review',
    description: '',
    kind: 'skill',
    insert: '$review ',
  });
  const long = commandEntry({ name: 'x', description: 'd'.repeat(1000), hint: 'h'.repeat(1000) });
  assert.equal(long?.description.length, 300);
  assert.equal(long?.hint?.length, 120);
  for (const bad of [null, 'text', {}, { name: '' }, { name: '   ' }, { name: 'two words' }, { name: 'a\0b' }, { name: 5 }])
    assert.equal(commandEntry(bad), null, JSON.stringify(bad));
});

test('the answer is read as bounded, shaped, de-duplicated entries; anything else is not an answer', () => {
  assert.equal(readCommands(null), null);
  assert.equal(readCommands({ commands: [], listed: 'yes' }), null);
  assert.equal(readCommands({ listed: true, commands: 'none' }), null);
  assert.deepEqual(readCommands({ listed: false, commands: [] }), { listed: false, commands: [] });
  const read = readCommands({
    listed: true,
    commands: [{ name: 'a' }, { name: 'a', description: 'again' }, null, { name: 'b b' }, { name: 'c' }],
  });
  assert.equal(read?.listed, true);
  assert.deepEqual(
    read?.commands.map((c: any) => [c.name, c.description]),
    [
      ['a', ''],
      ['c', ''],
    ],
    'the first of a name wins, a bad entry is left out',
  );
  const many = Array.from({ length: COMMANDS_MAX + 20 }, (_, i) => ({ name: `c${i}` }));
  assert.equal(readCommands({ listed: true, commands: many })?.commands.length, COMMANDS_MAX);
});

test('Claude Code: its commands and skills, without the ones that only exist in a terminal', () => {
  const entries = claudeEntries({
    commands: [
      { name: 'compact', description: 'Summarize', argumentHint: '[focus]' },
      { name: 'status', description: 'terminal only' },
      { name: 'loop', description: 'Run on an interval' },
      { name: 'deploy-notes', description: 'A skill of the project' },
      { description: 'no name' },
    ],
    skills: ['deploy-notes'],
    terminalSlash: ['loop'],
  });
  assert.deepEqual(
    entries.map((e: any) => [e.name, e.kind, e.insert, e.hint]),
    [
      ['compact', 'command', '/compact ', '[focus]'],
      ['deploy-notes', 'skill', '/deploy-notes ', undefined],
    ],
  );
  assert.deepEqual(claudeEntries(null), []);
  assert.deepEqual(claudeEntries({ commands: [{ name: 'compact' }], skills: 'x', terminalSlash: 'y' }).length, 1);
});

test('Codex: the enabled skills of the folder, a project’s over the user’s, each mentioned as $name', () => {
  const entries = codexEntries({
    data: [
      {
        cwd: '/p',
        skills: [
          { name: 'review', description: 'user review', scope: 'user', path: '/u/review' },
          { name: 'review', description: 'project review', shortDescription: 'Review this repo', scope: 'repo', path: '/p/review' },
          { name: 'old', description: 'off', scope: 'user', enabled: false },
          { name: 'sys', description: 'bundled', scope: 'system' },
          { name: 'sys', description: 'bundled again', scope: 'system' },
          { description: 'no name' },
          null,
        ],
      },
      { cwd: '/q' },
    ],
  });
  assert.deepEqual(
    entries.map((e: any) => [e.name, e.description, e.kind, e.insert]),
    [
      ['review', 'Review this repo', 'skill', '$review '],
      ['sys', 'bundled', 'skill', '$sys '],
    ],
  );
  assert.deepEqual(codexEntries(undefined), []);
  assert.deepEqual(codexEntries({ data: 'x' }), []);
});

test('the list of an agent: read from its own source, bounded; one that cannot say, or is not asked for, lists none', async () => {
  const seen: unknown[] = [];
  const reported: string[] = [];
  const many = Array.from({ length: COMMANDS_MAX + 5 }, (_, i) => ({ name: `s${i}` }));
  const list = createHostCommands({
    claude: async (cwd: string | undefined) => (seen.push(cwd), { commands: [{ name: 'compact' }] }),
    codex: async () => ({ data: [{ skills: many }] }),
    report: (note: string) => reported.push(note),
  });
  const claude = await list({ harness: 'claude', cwd: '/p' });
  assert.deepEqual([claude.listed, claude.commands.length, seen], [true, 1, ['/p']]);
  assert.equal((await list({ harness: 'codex' })).commands.length, COMMANDS_MAX);
  // an ACP agent's list comes with its live session, so there is none to read here
  assert.deepEqual(await list({ harness: 'acp:kimi' }), { listed: false, commands: [] });
  assert.equal(reported.length, 0);

  const without = createHostCommands({});
  assert.deepEqual(await without({ harness: 'claude' }), { listed: false, commands: [] });
  assert.deepEqual(await without({ harness: 'codex' }), { listed: false, commands: [] });

  const failing = createHostCommands({
    claude: async () => Promise.reject(new Error('not signed in')),
    codex: () => Promise.reject('plain text'),
    report: (note: string) => reported.push(note),
  });
  assert.deepEqual(await failing({ harness: 'claude' }), { listed: false, commands: [] });
  assert.deepEqual(await failing({ harness: 'codex' }), { listed: false, commands: [] });
  assert.deepEqual(reported, ['Could not read the commands of claude: not signed in', 'Could not read the commands of codex: plain text']);
});

test('a slow agent does not hold the menu: its list is none after the time it is given', async () => {
  const reported: string[] = [];
  const list = createHostCommands({ claude: () => new Promise(() => undefined), timeoutMs: 20, report: (n: string) => reported.push(n) });
  assert.deepEqual(await list({ harness: 'claude' }), { listed: false, commands: [] });
  assert.deepEqual(reported, ['Could not read the commands of claude: timed out']);
});

test('the commands feature is offered only by a Host that has a source, the journal ones only with a data dir', () => {
  const all = ['hostRead', 'commands', 'chatList', 'journalLifecycle'];
  assert.deepEqual(offeredFeatures(all, { dataDir: '/d', commands: () => undefined }), all);
  assert.deepEqual(offeredFeatures(all, { dataDir: '/d' }), ['hostRead', 'chatList', 'journalLifecycle']);
  assert.deepEqual(offeredFeatures(all, { commands: () => undefined }), ['hostRead', 'commands']);
  assert.deepEqual(offeredFeatures(all, {}), ['hostRead']);
});

function protocolWith(t: { after: (fn: () => void) => void }, commands?: (p: any) => Promise<unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-commands-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = { host, send: async () => ({ turnId: 't' }), prepare: async () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), { report: () => undefined });
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), { report: () => undefined }) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), ...(commands ? { commands } : {}) });
  const conn = protocol.connection(() => undefined);
  const hello = conn.call('host.hello', helloParams());
  return { conn, hello };
}

test('over the protocol: a Host with a source answers host.commands for the agent and folder asked, and one without refuses it', async (t) => {
  const asked: unknown[] = [];
  const served = protocolWith(t, async (p) => (asked.push(p), { listed: true, commands: [{ name: 'compact' }] }));
  const hello: any = await served.hello;
  assert.ok(hello.features.includes('commands'));
  assert.deepEqual(await served.conn.call('host.commands', { harness: 'claude', cwd: '/proj' }), {
    listed: true,
    commands: [{ name: 'compact' }],
  });
  await served.conn.call('host.commands', { harness: 'acp:kimi' });
  await served.conn.call('host.commands', { harness: 'codex', cwd: 'C:\\proj' });
  await served.conn.call('host.commands', { harness: 'codex', cwd: '\\\\server\\share' });
  assert.deepEqual(asked, [
    { harness: 'claude', cwd: '/proj' },
    { harness: 'acp:kimi' },
    { harness: 'codex', cwd: 'C:\\proj' },
    { harness: 'codex', cwd: '\\\\server\\share' },
  ]);
  for (const bad of [{}, { harness: 'gemini' }, { harness: 'claude', cwd: 'relative' }, { harness: 'claude', cwd: '' }])
    await assert.rejects(served.conn.call('host.commands', bad), `${JSON.stringify(bad)} is not a question`);

  const plain = protocolWith(t);
  assert.ok(!((await plain.hello) as any).features.includes('commands'));
  await assert.rejects(plain.conn.call('host.commands', { harness: 'claude' }));
});

test('a failing agent with no report given still lists none; a handler built with no source refuses in its own words', async () => {
  const list = createHostCommands({ claude: () => Promise.reject(new Error('x')) });
  assert.deepEqual(await list({ harness: 'claude' }), { listed: false, commands: [] });
  const handler = commandsMethod({}).handlers['host.commands'];
  assert.throws(() => handler({ harness: 'claude' }), /lists no commands/);
});
