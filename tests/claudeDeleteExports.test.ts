// Claude's exported and native IPC deletion routes share one retirement-aware helper with inert process boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createDeleteSession } from '../electron/harness/claude/delete.cjs';
import { inertClockPort } from './support/ports/clock.ts';

test('Claude module exports the real delete helper and registers no window delete channel with inert dependencies', async () => {
  const calls: string[] = [];
  const forkBoundaries: any[] = [];
  const state = {
    sessions: new Map(),
    retiring: new Map(),
    endedTips: new Set(['exported']),
    sdk: async () => ({
      deleteSession: async (id: string) => {
        calls.push(`delete:${id}`);
        return id;
      },
    }),
  };
  const factories: Record<string, unknown> = {
    './delete.cjs': { createDeleteSession },
    './linkedFork.cjs': {
      createLinkedClaudeFork: (options: any) => {
        forkBoundaries.push(options);
        return async (id: string, cwd: string) => ({ id, cwd, sdk: await options.sdk() });
      },
    },
    './forks.cjs': { createForks: () => ({ register: () => {}, claim: () => {}, setChatNames: () => {} }) },
    './rename.cjs': { createRename: () => async () => {} },
    './userTitle.cjs': { createUserTitle: () => async () => null },
    './state.cjs': { createState: () => state },
    'node:path': { join: (...parts: string[]) => parts.join('/') },
    './sessions.cjs': {
      createSessions: () => ({
        remote: { registerIpc: () => {}, release: () => null },
        retire: async (id: string) => {
          calls.push(`retire:${id}`);
        },
      }),
    },
    './transcripts.cjs': { createTranscripts: () => ({}) },
    './auth.cjs': { createAuth: () => ({ artifacts: { registerIpc: () => {} } }) },
    './cli.cjs': { createCli: () => ({}) },
    './governor.cjs': { createClaudeGovernor: () => ({}) },
    './warm.cjs': { createWarm: () => ({}) },
    './queries.cjs': { createQueries: () => ({}) },
    './usageSchedule.cjs': { createUsageSchedule: () => ({}), loginAccounts: () => ({}) },
    './catalog.cjs': { createCatalog: () => ({}) },
    './chromeSessions.cjs': { createChromeSessions: () => ({}) },
    './loginIdentity.cjs': { serverIdOf: () => null },
    './identityApi.cjs': { createIdentityApi: () => ({}) },
    './cliLoginRead.cjs': { readCliLogin: async () => {} },
    './designLogin.cjs': { createDesignLogin: () => ({}) },
    './accounts.cjs': { ClaudeAccounts: class {} },
    '../../platform/ports/paths.cjs': { paths: { userData: () => '/in-memory-only' } },
    '../../platform/ports/openExternal.cjs': { openExternal: () => {} },
    './transcriptEdits.cjs': {},
    '../../identity/contract/claudeBilling.cjs': {},
    './sessionOptions.cjs': {},
    './tasks.cjs': {},
    // the options it gets, so the test can call them: the live sessions and the same retire
    '../routeProcesses.cjs': { claudeProcesses: (o: any) => o },
    '../../ignored.cjs': {},
    '../../platform/ports/clock.cjs': inertClockPort,
    '../../platform/searchScans.cjs': {},
    '../../ledger/accounts.cjs': {},
  };
  const source = new URL('../electron/harness/claude/index.cjs', import.meta.url);
  const module: { exports: any } = { exports: {} };
  // Only repository source is read. All factory, SDK, Electron and timer boundaries are inert.
  runInNewContext(
    readFileSync(source, 'utf8'),
    {
      module,
      require: (name: string) => {
        assert.ok(Object.hasOwn(factories, name), `Unexpected dependency: ${name}`);
        return factories[name];
      },
      setInterval: () => ({ unref() {} }),
    },
    { filename: fileURLToPath(source) },
  );
  const handlers = new Map<string, (...args: any[]) => any>();
  // the harness the module makes (createClaudeHarness), as main makes it
  const harness = module.exports.createClaudeHarness();
  harness.register({ handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }, () => {});
  assert.equal(await harness.deleteSession('exported'), 'exported');
  // a window deletes a chat only through chats:delete (ChatDeletion), never a claude:* channel
  assert.equal(handlers.has('claude:delete'), false);
  assert.deepEqual(calls, ['retire:claude:exported', 'delete:exported']);
  assert.equal(state.endedTips.size, 0);
  const fork = await harness.forkLinkedSession('source', '/child');
  assert.deepEqual([fork.id, fork.cwd], ['source', '/child']);
  assert.equal(typeof fork.sdk.deleteSession, 'function');
  assert.equal(forkBoundaries.length, 1);
  // Restart to apply (electron/harness/routeProcesses.cjs) reads these sessions and ends them through the same retire
  assert.equal(harness.routeProcesses.sessions(), state.sessions);
  await harness.routeProcesses.retire('claude:route');
  assert.equal(calls.at(-1), 'retire:claude:route');
});
