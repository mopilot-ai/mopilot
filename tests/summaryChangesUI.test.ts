// Repository totals in the Changes card refresh on focus and open the same branch scope.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, popoverStub, render, one } from './support/shell-panels-kit.ts';
import { createElement as h, act } from 'react';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
const store = fakeStore({ threads: { chat: { cwd: '/repo' } }, runtime: { chat: { turns: [] } }, prefs: { openDestination: 'finder' } });
const fixture = { files: [{ added: 12, removed: 3 }], scope: [] as string[], fail: false };
stubStore(store.exports);
installNativeStub({
  // main's context snapshots (src/session/useContextSnapshot.ts): none known
  context: { get: async () => null, refresh: async () => null, onSnapshot: () => () => {} },
  git: {
    info: async () => ({ root: '/repo', remote: 'origin' }),
    gh: async () => ({ ok: false }),
  },
});
mock.module('../src/lib/repositoryChanges.ts', {
  namedExports: {
    repositoryDiffFiles: async (_git: unknown, _cwd: string, scope: string) => {
      fixture.scope.push(scope);
      if (fixture.fail) throw Error('offline');
      return fixture.files;
    },
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStub });
// the summary's Pull requests card reads its chat's PRs and has its own tests (tests/prInboxAllUI.test.ts)
mock.module('../src/components/panels/SummaryPullRequests.tsx', { namedExports: { SummaryPullRequests: () => null } });
mock.module('../src/components/panels/PullRequestRow.tsx', { namedExports: { PullRequestRow: () => null } });
// the machine chip and Remote Control row have their own test (summaryEnvironmentUI.test.ts)
mock.module('../src/components/panels/SummaryEnvironment.tsx', {
  namedExports: { SummaryMachine: () => null, SummaryRemoteControl: () => null },
});
const { SummaryPanel } = await import('../src/components/panels/SummaryPanel.tsx');

test('summary labels branch totals, refreshes on focus, and opens that exact scope', async () => {
  const r = await render(h(SummaryPanel, { threadId: 'chat' }));
  const branch = () => one(r.host, '.summary-row', 'Branch changes');
  assert.match(branch().textContent!, /Branch changes1 file\+12 -3/);
  assert.equal(r.host.querySelector('.summary-changes summary'), null, 'open the branch diff directly from the only Changes row');
  assert.equal(fixture.scope[0], 'branch');
  await act(() => branch().click());
  assert.deepEqual(store.calls.at(-1), ['openChanges', { scope: 'branch' }]);
  fixture.files = [{ added: 20, removed: 4 }];
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.match(branch().textContent!, /Branch changes1 file\+20 -4/);
  fixture.fail = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  assert.equal(branch().querySelector('.diff-stat'), null, 'unavailable totals must not look like a clean repo');
  assert.match(branch().textContent!, /Unavailable/);
  await r.unmount();
});
