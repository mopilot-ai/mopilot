// The composer's "/" Worktree entry for a new-chat draft (useSlashItems in src/components/composer/ComposerSlash.tsx): it
// follows the draft's context bar, so a folder that can't hold a worktree never offers a switch that does nothing.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $$, mouse } from './support/composer-kit.ts';
import { all, fx, mountComposer, reset, settle, store } from './support/composer-setup.ts';

beforeEach(() => reset());
const titles = () => $$('.slash-panel .add-panel-title').map((x) => x.textContent);
const row = (title: string) => $$('.slash-panel .add-panel-item').find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;
const desc = (title: string) => row(title).querySelector('.add-panel-desc')?.textContent;

test("a draft's Worktree entry follows its context bar: none outside a project, a repo or a local folder; greyed out with no commits", async () => {
  const { NO_COMMITS } = await import('../shared/worktreeSupport.mjs');
  fx.branches = {
    '/w/repo': { current: 'main', default: 'main', branches: ['main'], commits: true },
    '/w/empty': { current: 'main', default: null, branches: [], commits: false },
  };
  const m = await mountComposer({ threadId: null });
  const worktree = () => titles().includes('Worktree');
  const at = async (project: any, cloud: any = null) => {
    fx.project = project;
    store.set({ newChatCloudEnv: cloud });
    await m.rerender();
    await settle();
    await m.type('/work');
  };
  try {
    await at(null);
    assert.equal(worktree(), false, 'a chat outside a project has no switch');
    await at({ name: 'Plain', path: '/w/plain' });
    assert.equal(worktree(), false, 'not a git repo: nothing to choose');
    await at({ name: 'Empty', path: '/w/empty' });
    assert.equal(row('Worktree').getAttribute('aria-disabled'), 'true');
    assert.equal(row('Worktree').title, `Worktree unavailable: ${NO_COMMITS}`);
    assert.equal(desc('Worktree'), NO_COMMITS);
    await mouse(row('Worktree'), 'mousedown');
    assert.equal(all('worktree').length, 0, 'a greyed-out entry does nothing');
    await at({ name: 'Repo', path: '/w/repo' });
    assert.equal(row('Worktree').getAttribute('aria-disabled'), 'false');
    assert.equal(desc('Worktree'), 'Turn worktree mode on');
    fx.caps.cloud = 'native';
    await at({ name: 'Repo', path: '/w/repo' }, { id: 'e1', label: 'Env one' });
    assert.equal(worktree(), false, 'no worktree in the cloud');
  } finally {
    await m.unmount();
  }
});
