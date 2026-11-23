// The summary's changes group for a chat on a machine (src/components/panels/SummaryRemoteRepo.tsx): what the machine's Host read, or why there is nothing to show.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render } from './support/shell-panels-kit.ts';
const opened: unknown[][] = [];
mock.module('../src/store/panes.ts', { namedExports: { openChanges: (...a: unknown[]) => opened.push(a) } });
const { SummaryRemoteRepo } = await import('../src/components/panels/SummaryRemoteRepo.tsx');

const BOX = { id: 'm', name: 'box', away: false };
const ready = (o: object = {}) => ({
  state: 'ready' as const,
  branch: 'main',
  remote: null,
  files: 3,
  added: 7,
  removed: 2,
  untracked: 0,
  truncated: false,
  ...o,
});
const text = async (machine: typeof BOX, repo: any) => {
  const v = await render(h(SummaryRemoteRepo, { machine, repo }));
  const t = v.host.textContent;
  await v.unmount();
  return t;
};

test('an offline machine and an answer not yet in say so in one line; a refusal shows its notice', async () => {
  assert.equal(await text({ ...BOX, away: true }, ready()), "Branch and changes aren't available while box is offline.");
  assert.equal(await text(BOX, null), "Branch and changes aren't shown for a folder on box.");
  assert.equal(await text(BOX, { state: 'unavailable', notice: 'Update the Host on that machine.' }), 'Update the Host on that machine.');
});

test('reading and not a repository draw nothing; a repository shows its files and lines, a clean one says no changes', async () => {
  assert.equal(await text(BOX, { state: 'loading' }), '');
  assert.equal(await text(BOX, { state: 'none' }), '');
  assert.equal(await text(BOX, ready()), 'Branch changes3 files+7 -2');
  assert.equal(await text(BOX, ready({ files: 1, untracked: 1, truncated: true })), 'Branch changes1 file++7 -2');
  assert.equal(await text(BOX, ready({ files: 0, added: 0, removed: 0 })), 'Branch changesNo changes');
  assert.equal(await text(BOX, ready({ files: 0, added: 0, removed: 0, truncated: true })), 'Branch changesUnavailable');
  const v = await render(h(SummaryRemoteRepo, { machine: BOX, repo: ready({ untracked: 1 }) }));
  assert.equal(v.host.querySelector('.summary-hint')!.getAttribute('title'), "Lines of new files aren't counted");
  await v.unmount();
});

test('the row opens the Changes pane', async () => {
  const v = await render(h(SummaryRemoteRepo, { machine: BOX, repo: ready() }));
  (v.host.querySelector('button.summary-row') as HTMLElement).click();
  assert.deepEqual(opened, [[{ scope: 'branch' }]]);
  await v.unmount();
});
