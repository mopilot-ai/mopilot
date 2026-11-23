// Hidden persistent right-pane hosts do not reveal Changes or present their terminal as visible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { autoMock, mockStore, resetStore, render } from './support/thread-kit.ts';

const opens: string[] = [];
mockStore({ openChanges: () => opens.push('changes') });
for (const [path, exports] of [
  ['DiffPanel', ['DiffPanel']],
  ['FilesPanel', ['FilesPanel', 'FilePreview']],
  ['SkillPanel', ['SkillPanel']],
  ['BrowserPanel', ['BrowserPanel']],
] as const) {
  autoMock(`src/components/panels/${path}.tsx`, path, Object.fromEntries(exports.map((name) => [name, () => null])));
}
autoMock('src/components/panels/TerminalPanel.tsx', 'term', {
  TermView: ({ visible }: { visible: boolean }) => h('div', { 'data-term-visible': String(visible) }),
});
autoMock('src/session/harness/claude.ts', 'claude');
autoMock('src/components/composer/Composer.tsx', 'composer');
autoMock('src/components/thread/ThreadView.tsx', 'thread');
autoMock('src/components/tasks/TasksTab.tsx', 'tasks');
const { SidePane } = await import('../src/components/panels/SidePane.tsx');

test('a hidden empty host cannot open Changes, and a retained terminal is invisible until the pane returns', async () => {
  const original = HTMLElement.prototype.animate;
  HTMLElement.prototype.animate = (() => ({ cancel() {} })) as any;
  resetStore({ paneTabs: [], paneActive: '', paneFull: false, agentTabs: {}, segments: {} });
  const empty = await render(h(SidePane, { cwd: '/repo', threadId: 'a', hidden: true }));
  assert.equal(empty.$('.side-pane')!.hidden, true);
  assert.deepEqual(opens, []);
  await empty.unmount();
  resetStore({ paneTabs: [{ id: 'term', kind: 'terminal' }], paneActive: 'term', paneFull: false, agentTabs: {}, segments: {} });
  const terminal = await render(h(SidePane, { cwd: '/repo', threadId: 'a', hidden: true }));
  assert.equal(terminal.$('[data-term-visible]')!.getAttribute('data-term-visible'), 'false');
  await terminal.rerender(h(SidePane, { cwd: '/repo', threadId: 'a' }));
  assert.equal(terminal.$('[data-term-visible]')!.getAttribute('data-term-visible'), 'true');
  await terminal.unmount();
  HTMLElement.prototype.animate = original;
});
