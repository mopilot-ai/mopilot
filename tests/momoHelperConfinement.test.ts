// Every helper run written for a MoMo chat is as confined as the chat (#2364): the handoff note a harness switch asks the old
// harness for, and a chat's title, on Claude Code, Codex and ACP. A helper for another chat is untouched. The last test is the
// guard: every place that starts a model run beside a chat is listed here with how it is confined, so a new one fails until
// it is added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, settle, thread } from './support/codex-harness/fixture.ts';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { createQueries } = require('../electron/harness/claude/queries.cjs');
const { AcpHost } = require('../electron/harness/acp.cjs');
const { SwitchRunner } = require('../electron/session/switch.cjs');

const MOMO = 'momo-chat';

/** The Claude queries with a fake SDK: the options every `query()` was started with. */
function claudeQueries() {
  const runs: { prompt: any; options: any }[] = [];
  const state: any = {
    isolated: (chatId: string) => chatId === MOMO,
    sdk: async () => ({
      query: (run: { prompt: any; options: any }) => {
        runs.push(run);
        return (async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'the note' }] } };
          yield { type: 'result' };
        })();
      },
    }),
  };
  const queries = createQueries(state, {
    auth: { cleanEnv: () => ({ PATH: '/bin' }) },
    cli: { findBinary: async () => '/bin/claude' },
  });
  return { queries, runs };
}

/** Everything a confined helper run lacks: instructions, memory, built-in tools, MCP servers and connectors. */
function assertConfined(options: any) {
  assert.deepEqual(options.tools, [], 'no built-in tools');
  assert.equal(options.strictMcpConfig, true, 'only the MCP servers it is given');
  assert.equal(options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(options.settings.autoMemoryEnabled, false);
}

test('Claude Code: the handoff note for a MoMo chat is written without CLAUDE.md, memory, tools or connectors; a coding chat’s is as before', async () => {
  const { queries, runs } = claudeQueries();
  assert.equal(await queries.summarize('s1', '/w', 'note', undefined, undefined, MOMO), 'the note');
  assertConfined(runs[0].options);
  // the settings sources stay as in the chat's own session (login, permissions); CLAUDE.md is off by the CLI's switch
  assert.deepEqual(runs[0].options.settingSources, ['user', 'project', 'local']);
  // the note is still written from the conversation: the session is resumed in a hidden fork
  assert.equal(runs[0].options.resume, 's1');
  assert.equal(runs[0].options.forkSession, true);
  assert.equal(runs[0].options.persistSession, false);

  await queries.summarize('s2', '/w', 'note', undefined, undefined, 'coding-chat');
  assert.deepEqual(runs[1].options.settingSources, ['user', 'project', 'local']);
  assert.equal(runs[1].options.tools, undefined);
  assert.equal(runs[1].options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, undefined);
  // no chat named (an older caller): nothing to confine
  await queries.summarize('s3', '/w', 'note');
  assert.deepEqual(runs[2].options.settingSources, ['user', 'project', 'local']);
});

test('Claude Code: a MoMo chat’s title is written confined too; a coding chat’s title keeps its options', async () => {
  const { queries, runs } = claudeQueries();
  assert.equal(await queries.title('hello', '/w', undefined, undefined, MOMO), 'the note');
  assertConfined(runs[0].options);
  assert.equal(runs[0].options.model, 'haiku');
  assert.deepEqual(runs[0].options.settingSources, []);
  await queries.title('hello', '/w', undefined, undefined, 'coding-chat');
  assert.equal(runs[1].options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, undefined);
  assert.equal(runs[1].options.strictMcpConfig, undefined);
});

test('Claude Code: a MoMo chat’s title is never asked of the warm title CLI; a coding chat’s is, on lean options', async () => {
  const { queries, runs } = claudeQueries();
  assert.equal(await queries.title('hello', '/w', undefined, undefined, MOMO, { helper: true }), null);
  assert.equal(runs.length, 0, 'no warm CLI for a MoMo chat');
  // the fake CLI is too old to write titles: null, and the caller asks the chat's own CLI
  assert.equal(await queries.title('hello', '/w', undefined, 'a1', 'coding-chat', { helper: true }), null);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].options.settingSources, []);
  assert.deepEqual(runs[0].options.tools, []);
  assert.equal(runs[0].options.model, 'haiku');
  assert.equal(runs[0].options.persistSession, false);
  assert.equal(runs[0].options.cwd, os.homedir());
  // no chat named (an older caller): the warm CLI writes it
  assert.equal(await queries.title('hello', '/w', undefined, 'a1', undefined, { helper: true }), null);
});

test('a harness switch asks Claude Code for the note with the chat id, so the rule applies', async () => {
  const asked: any[] = [];
  const runner = Object.create(SwitchRunner.prototype);
  runner.prefs = () => ({ claudeBin: 'claude' });
  runner.claude = {
    accountOf: () => 'acct',
    summarize: async (...args: unknown[]) => (asked.push(args), 'note'),
  };
  assert.equal(await runner.summarize(MOMO, 'claude', { id: 's1' }, '/w'), 'note');
  assert.equal(asked[0][5], MOMO);
});

test('Codex: the handoff fork of a MoMo thread runs with its memory off and in the strictest sandbox; a coding thread’s fork is as before', async () => {
  const forkOf = (id: string) => ({ thread: thread(id, { ephemeral: true }) });
  let n = 0;
  const { a, server } = setup(
    {
      'thread/fork': () => forkOf(`fork-${++n}`),
      'turn/start': (p: any) => {
        setImmediate(() => {
          server.notify('item/completed', { threadId: p.threadId, item: { type: 'agentMessage', text: 'the note' } });
          server.notify('turn/completed', { threadId: p.threadId, turn: { id: 't' } });
        });
        return { turn: { id: 't' } };
      },
    },
    { isolated: (chatId: string) => chatId === 'momo-thread' },
  );
  assert.equal(await a.summarize('momo-thread', 'note'), 'the note');
  await settle();
  const memory = server.params('thread/memoryMode/set');
  assert.deepEqual(memory, [{ threadId: 'fork-1', mode: 'disabled' }]);
  const [turn] = server.params('turn/start');
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turn.approvalPolicy, 'never');
  // memory went off before the turn ran
  assert.ok(server.methods().indexOf('thread/memoryMode/set') < server.methods().indexOf('turn/start'));

  assert.equal(await a.summarize('coding-thread', 'note'), 'the note');
  assert.equal(server.params('thread/memoryMode/set').length, 1, 'a coding thread’s fork is not touched');
});

test('Codex: a MoMo chat is not titled by a helper thread that reads its folder; a coding chat is', async () => {
  const { a, server } = setup(
    {
      'thread/start': () => {
        throw new Error('no helper thread in this test');
      },
    },
    { isolated: (chatId: string) => chatId === 'momo-thread' },
  );
  await a.autoTitle('momo-thread', 'hello');
  assert.equal(server.params('thread/start').length, 0);
  assert.equal(a.titling.has('momo-thread'), false);
  a.titling.clear();
  await a.autoTitle('coding-thread', 'hello').catch(() => undefined);
  assert.equal(server.params('thread/start').length, 1);
});

test('ACP: a MoMo chat gets no title session on its agent; a coding chat does', async () => {
  const writes: unknown[][] = [];
  const key = 'acp:kimi:s1';
  const host: any = {
    chats: new Map([[key, { agent: {}, cwd: '/w', harness: 'acp:kimi' }]]),
    quirksOf: () => undefined,
    titleSessions: { write: async (...args: unknown[]) => (writes.push(args), 'a title') },
    isolated: (k: string) => k === key,
  };
  assert.equal(await AcpHost.prototype.titleFor.call(host, key, 'hello', 1000), null);
  assert.equal(writes.length, 0);
  host.isolated = () => false;
  assert.equal(await AcpHost.prototype.titleFor.call(host, key, 'hello', 1000), 'a title');
});

/**
 * Guard: every place that starts a model run beside a chat, by file, and how a MoMo chat's run is confined. A new run
 * not listed here fails this test; list it with its confinement (and a test above) or route it through the helpers named.
 */
const HELPER_RUNS: { file: string; pattern: RegExp; count: number; confinedBy: string }[] = [
  // Claude Code: the SDK's query() outside a chat's own session. probe, usage and extras send no prompt; summarize and title confine.
  { file: 'electron/harness/claude/queries.cjs', pattern: /\bquery\(/g, count: 4, confinedBy: 'confineHelperOptions' },
  // Claude Code: the warm title CLI per login (#3413), never asked for a MoMo chat's title (queries.cjs title)
  { file: 'electron/harness/claude/titleHelper.cjs', pattern: /\bquery\(/g, count: 1, confinedBy: 'isolated' },
  // Codex: the title's helper thread (skipped for a MoMo chat) and the handoff note's fork (isolation.helpers)
  { file: 'electron/harness/codexTurns.cjs', pattern: /\{ helper: true \}/g, count: 2, confinedBy: 'isolation' },
];

test('guard: every helper run beside a chat is listed with its confinement', () => {
  const root = path.resolve(import.meta.dirname, '..');
  for (const run of HELPER_RUNS) {
    const source = fs.readFileSync(path.join(root, run.file), 'utf8');
    assert.equal(
      source.match(run.pattern)?.length ?? 0,
      run.count,
      `${run.file}: a model run was added or removed beside a chat; confine it for MoMo's chats (${run.confinedBy}) and update HELPER_RUNS`,
    );
    assert.ok(source.includes(run.confinedBy), `${run.file} no longer mentions ${run.confinedBy}`);
  }
  // no other module of electron/ or the Claude harness starts a Claude query: a new one must be listed with how a MoMo
  // chat's run is confined
  const queryFiles = ['electron', 'electron/harness/claude']
    .flatMap((dir) => fs.readdirSync(path.join(root, dir)).map((f) => `${dir}/${f}`))
    .filter((f) => f.endsWith('.cjs') && /\bquery\(/.test(fs.readFileSync(path.join(root, f), 'utf8')))
    .sort();
  assert.deepEqual(queryFiles, [
    'electron/harness/claude/queries.cjs',
    'electron/harness/claude/sessions.cjs',
    'electron/harness/claude/titleHelper.cjs',
    'electron/harness/claude/usage.cjs',
  ]);
  // the Claude helpers take the chat id and confine on it
  const queries = fs.readFileSync(path.join(root, 'electron/harness/claude/queries.cjs'), 'utf8');
  assert.equal(queries.match(/if \(chatId && state\.isolated\?\.\(chatId\)\) confineHelperOptions\(options\)/g)?.length, 2);
});
