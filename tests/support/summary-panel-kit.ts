// The Changes card's fake Git and PR-monitor boundaries, shared by its UI test suites.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { fakeStore, popoverStub, settle, render } from './shell-panels-kit.ts';
import { fakeNative } from './ports/native.ts';
import { installNative } from '../../src/lib/native.ts';
import { stubStore } from './stubs.ts';

export async function summaryPanelKit() {
  const kit = { monitors: {} as Record<string, any> };
  const store = fakeStore({ threads: {}, runtime: {}, prefs: { openDestination: 'finder' } });
  const calls: unknown[][] = [];
  const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
  const impl: Record<string, (...a: any[]) => Promise<any>> = {};
  const prUrl = 'https://github.com/o/r/pull/7';

  const monitorListeners = new Set<(id: string) => void>();
  const native = {
    context: { get: async () => null, refresh: async () => null, onSnapshot: () => () => {} },
    prMonitor: {
      snapshot: async (id: string) => kit.monitors[id] ?? null,
      configure: (id: string, patch: any) => (calls.push(['configure', id, patch]), impl.configure(id, patch)),
      refresh: async (id: string) => kit.monitors[id] ?? null,
      createDraft: (id: string) => (calls.push(['createDraft', id]), impl.createDraft(id)),
      create: (id: string, input: any) => (calls.push(['create', id, input]), impl.create(id, input)),
      onChanged: (fn: (id: string) => void) => {
        monitorListeners.add(fn);
        return () => monitorListeners.delete(fn);
      },
    },
    git: {
      info: (cwd: string) => (calls.push(['info', cwd]), impl.info(cwd)),
      status: (cwd: string) => (calls.push(['status', cwd]), impl.status(cwd)),
      gh: (cwd: string, args: string[]) => (calls.push(['gh', cwd, ...args]), impl.gh(cwd, args)),
      // the branch's pushed repository, read only when gh finds no PR (src/lib/pullRequestSources.ts); not in `calls`
      run: (cwd: string, args: string[]) => impl.run(cwd, args),
    },
    shell: {
      openExternal: async (u: string) => {
        calls.push(['external', u]);
      },
      openPath: async (p: string) => {
        calls.push(['openPath', p]);
      },
      openIn: async (app: string, p: string) => {
        calls.push(['openIn', app, p]);
      },
    },
  };
  mock.module('../../src/lib/repositoryChanges.ts', {
    namedExports: {
      repositoryDiffFiles: async (_git: unknown, cwd: string, scope: string) => {
        assert.equal(scope, 'branch');
        const status = await native.git.status(cwd);
        if (!status) throw Error('status unavailable');
        return status.files;
      },
    },
  });
  stubStore(store.exports);
  installNative(fakeNative(native));
  mock.module('../../src/components/ui/Popover.tsx', { namedExports: popoverStub });
  // the summary's Pull requests card reads its chat's PRs and has its own tests (tests/prInboxAllUI.test.ts)
  mock.module('../../src/components/panels/SummaryPullRequests.tsx', { namedExports: { SummaryPullRequests: () => null } });
  const { createElement, act } = await import('react');
  // the machine chip and Remote Control row: tests/summaryEnvironmentUI.test.ts and tests/summaryProjectMenuUI.test.ts
  mock.module('../../src/components/panels/SummaryEnvironment.tsx', {
    namedExports: { SummaryMachine: () => null, SummaryRemoteControl: () => null },
  });
  const { SummaryPanel } = await import('../../src/components/panels/SummaryPanel.tsx');
  const gitInfo = { root: '/repo', branch: 'main', remote: 'origin', branches: ['main'] };
  function reset(threads: any, runtime: any) {
    calls.length = 0;
    store.calls.length = 0;
    store.set({ threads, runtime });
    impl.info = async (cwd: string) => ({ ...gitInfo, root: cwd });
    impl.status = async () => ({
      files: [
        { added: 3, removed: 1 },
        { added: 2, removed: 0 },
      ],
    });
    impl.gh = async () => ok(JSON.stringify({ number: 7, url: prUrl, title: 'Fix it', state: 'OPEN' }));
    impl.run = async () => ({ ok: false, stdout: '', stderr: '', code: 128 });
    kit.monitors = {};
    impl.createDraft = async () => ({
      status: 'draft',
      branch: 'feature',
      base: 'main',
      stacked: false,
      title: 'Fix it',
      body: 'Because.',
      commits: 1,
    });
    impl.create = async (id: string) => {
      kit.monitors[id] = { chatId: id, url: prUrl, autoFix: false, addressComments: false, uncertain: false, limited: false };
      return { status: 'created', url: prUrl, bound: true };
    };
    impl.configure = async (id: string, patch: any) => {
      kit.monitors[id] = { chatId: id, url: patch.url, autoFix: false, addressComments: false, uncertain: false, limited: false };
      return kit.monitors[id];
    };
  }
  async function mount(threadId = 't1') {
    const r = await render(createElement(SummaryPanel, { threadId }));
    await settle(act);
    return r;
  }
  const turn = (items: any[] = [], extra: any = {}) => ({ id: `turn-${Math.random()}`, items, status: 'completed', ...extra });
  return Object.assign(kit, { store, calls, ok, impl, prUrl, monitorListeners, native, SummaryPanel, gitInfo, reset, mount, turn });
}
