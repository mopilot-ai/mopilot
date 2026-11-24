// The "/" menu's Claude skill rows (useSlashItems in src/components/composer/ComposerSlash.tsx): the scope label comes from where the
// catalog found the skill's SKILL.md, and a skill with no file, or one named like an Object.prototype member, stays a plain Skill.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $$, mouse } from './support/composer-kit.ts';
import { fx, mountComposer, reset, store } from './support/composer-setup.ts';
beforeEach(() => reset());
const row = (title: string) => $$('.slash-panel .add-panel-item').find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;

test("Claude's skill rows say where the skill lives when its SKILL.md was found, else Skill", async () => {
  fx.nativeCmds = [{ name: 'compact' }];
  fx.provider = { label: 'Claude Code' };
  fx.registry = () => ({
    menu: ['mine', 'repo-one', 'plug:one', 'unknown', 'constructor'].map((name) => ({ name, dispatch: 'passthrough', source: 'skill' })),
    hidden: [],
  });
  fx.skillFiles = {
    mine: { path: '/h/mine/SKILL.md', description: '', scope: 'personal' },
    'repo-one': { path: '/p/SKILL.md', description: '', scope: 'project' },
    'plug:one': { path: '/x/SKILL.md', description: '', scope: 'plugin' },
  };
  store.set({ harnessOf: { t1: 'claude' } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/');
    const scope = (t: string) => row(t).querySelector('.add-panel-scope')!.textContent;
    assert.deepEqual(['/mine', '/repo-one', '/plug:one', '/unknown', '/constructor'].map(scope), [
      'Personal',
      'Project',
      'Plugin',
      'Skill',
      'Skill',
    ]);
    // picking one still types its name
    await mouse(row('/mine'), 'mousedown');
    assert.equal(m.text, '/mine ');
  } finally {
    await m.unmount();
  }
});
