// Claude renderer chat unit cases for startup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, claude, claudeThreadId, flush, log, onAccountsEvent, onCatalog, baseNative } from './fixture.ts';

export function registerStartup() {
  test('starting: events, logins and catalogs are wired once, then Claude is detected', async () => {
    let accountsAsked = 0;
    baseNative({ accounts: async () => (accountsAsked++, { active: 'work', accounts: [{ id: 'work' }] }) });
    claude.startClaude();
    claude.startClaude();
    await flush();
    assert.equal(accountsAsked, 1);
    assert.equal(fx.state.claudeAccounts.active, 'work');
    onCatalog({ account: 'work', cwd: '/w', catalog: { commands: [] } });
    assert.deepEqual(Object.values(fx.state.claudeCatalogs), [{ commands: [] }]);
  });

  test('a pinned login that signs in again serves its chats again; chats on other logins keep where they ran (R-4)', () => {
    const out = {
      active: 'a',
      accounts: [
        { id: 'a', loggedIn: true },
        { id: 'b', loggedIn: false },
        { id: 'c', loggedIn: true },
      ],
    };
    fx.state.claudeAccounts = out;
    const auto = { id: 'c', pinned: false };
    const elsewhere = { id: 'c', pinned: true, serving: 'a' };
    fx.state.claudeChats = { p1: { id: 'b', pinned: true, serving: 'c' }, p2: { id: 'b', pinned: true }, auto, elsewhere };
    // nothing signed in again: no change
    const before = fx.state.claudeChats;
    onAccountsEvent({ type: 'changed', state: { ...out } });
    assert.equal(fx.state.claudeChats, before);
    onAccountsEvent({ type: 'changed', state: { active: 'a', accounts: out.accounts.map((a) => ({ ...a, loggedIn: true })) } });
    assert.deepEqual(fx.state.claudeChats, { p1: { id: 'b', pinned: true }, p2: { id: 'b', pinned: true }, auto, elsewhere });
  });

  test('login events: list changes, a login added, a duplicate', async () => {
    onAccountsEvent({ type: 'changed', state: { active: 'default', accounts: [{ id: 'default' }] } });
    assert.deepEqual(fx.state.claudeAccounts.accounts, [{ id: 'default' }]);
    fx.state.claude.status = { state: 'signin', bin: null };
    onAccountsEvent({ type: 'login', kind: 'signedIn', email: 'a@x' });
    onAccountsEvent({ type: 'login', kind: 'signedIn' });
    onAccountsEvent({ type: 'login', kind: 'duplicate', email: 'a@x' });
    onAccountsEvent({ type: 'login', kind: 'duplicate' });
    onAccountsEvent({ type: 'login', kind: 'cancelled' });
    assert.deepEqual(called('toast'), [
      ['Added a@x', 'success'],
      ['Added a Claude account', 'success'],
      ['a@x is already signed in', 'error'],
      ['That account is already signed in', 'error'],
    ]);
  });

  test('the session list fills the sidebar, keeping local names and projects and skipping archived chats', async () => {
    const a = claudeThreadId('list-a');
    const z = claudeThreadId('list-z');
    fx.state.threads[a] = { id: a, name: 'Mine', projectId: 'p' };
    fx.state.threadOrder = [a];
    fx.state.claudeArchived = { [z]: 1 };
    baseNative({
      list: async ({ offset }: any) =>
        offset
          ? []
          : [
              { sessionId: 'list-a', lastModified: 5000, cwd: '/w' },
              {
                sessionId: 'list-b',
                customTitle: 'B',
                firstPrompt: 'hi',
                lastModified: 9000,
                createdAt: 1000,
                gitBranch: 'main',
                cwd: '/w',
              },
              { sessionId: 'list-c', summary: 'sum', lastModified: 0 },
              { sessionId: 'list-z', lastModified: 0 },
            ],
    });
    await claude.loadClaudeThreads();
    const t = fx.state.threads;
    assert.deepEqual([t[a].name, t[a].projectId, t[a].createdAt], ['Mine', 'p', 5]);
    const b = t[claudeThreadId('list-b')];
    assert.deepEqual([b.name, b.preview, b.createdAt, b.updatedAt, b.gitInfo.branch], ['B', 'hi', 1, 9, 'main']);
    const c = t[claudeThreadId('list-c')];
    assert.deepEqual([c.preview, c.cwd, c.gitInfo, c.projectId], ['sum', '', null, null]);
    assert.equal(t[z], undefined);
    assert.equal(fx.state.threadOrder.length, 3);
    assert.deepEqual(
      claude.archivedClaudeThreads().map((x) => x.id),
      [z],
    );
    // an unknown chat keeps the name the list gives it
    delete fx.state.threads[a];
    await claude.loadClaudeThreads();
    assert.equal(fx.state.threads[a].name, null);
    const warn = console.warn;
    const warned: any[] = [];
    console.warn = (...x: any[]) => void warned.push(x);
    baseNative({
      list: async () => {
        throw new Error('gone');
      },
    });
    await claude.loadClaudeThreads();
    console.warn = warn;
    assert.equal(warned[0][0], 'Claude sessions');
  });

  test('search, remembered chats and archived chats read from their own files', async () => {
    baseNative({
      search: async (term: string, n: number) => (log.push([term, n]), [{ sessionId: 's1', summary: 'found', lastModified: 0 }]),
    });
    assert.deepEqual(
      (await claude.searchClaudeThreads('foo')).map((t) => [t.id, t.preview]),
      [[claudeThreadId('s1'), 'found']],
    );
    assert.deepEqual(log, [['foo', 30]]);
    claude.rememberClaudeThread(undefined);
    claude.rememberClaudeThread({ id: claudeThreadId('kept'), name: 'Kept' } as any);
    const missingOk = claudeThreadId('arch-ok');
    const missingBad = claudeThreadId('arch-bad');
    fx.state.claudeArchived = { [claudeThreadId('kept')]: 1, [missingOk]: 1, [missingBad]: 1, 'codex-thread': 1 };
    baseNative({
      info: async (sid: string) =>
        sid === 'arch-ok' ? { sessionId: 'arch-ok', summary: 'old', lastModified: 0 } : Promise.reject(new Error('no file')),
    });
    await claude.loadArchivedClaudeInfo();
    assert.deepEqual(
      claude
        .archivedClaudeThreads()
        .map((t) => t.id)
        .sort(),
      [claudeThreadId('kept'), missingOk].sort(),
    );
    // a Codex chat archived in an earlier run isn't known here until Codex lists it
    assert.equal(claude.archivedCodexMissing(), true);
    claude.rememberClaudeThread({ id: 'codex-thread', name: 'Codex' } as any);
    fx.state.claudeArchived = { [claudeThreadId('kept')]: 1, 'codex-thread': 1, 'acp:kimi:a': 1 };
    assert.equal(claude.archivedCodexMissing(), false);
  });
}

export function registerFailedStartup() {
  test('starting with an account read that fails leaves the logins to the accounts events', async () => {
    // startClaude runs once per module: a fresh copy starts against a failing read
    const fresh: typeof claude = await import(`${new URL('../../../src/session/harness/claude.ts', import.meta.url).href}?accounts-fail`);
    let asked = 0;
    baseNative({
      accounts: async () => {
        asked++;
        throw new Error('main not ready');
      },
    });
    const before = fx.state.claudeAccounts;
    fresh.startClaude();
    await flush();
    assert.equal(asked, 1);
    assert.equal(fx.state.claudeAccounts, before, 'nothing replaced on a failed read');
    onAccountsEvent({ type: 'changed', state: { active: 'default', accounts: [{ id: 'default' }] } });
    assert.deepEqual(fx.state.claudeAccounts.accounts, [{ id: 'default' }]);
  });
}
