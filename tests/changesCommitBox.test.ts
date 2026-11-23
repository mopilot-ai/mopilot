// src/components/panels/ChangesCommit.tsx's commit box: a path listed twice (a file turned into a link) is one file with one tick, and an unticked file no longer listed still keeps the commit to the ticked files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { render, click, type, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const toasts: unknown[][] = [];
const sent: unknown[][] = [];
stubStore({ toast: (...a: unknown[]) => toasts.push(a) });
installNativeStub({
  git: {
    commitFiles: async (...a: unknown[]) => (
      sent.push(a), { ok: true, stdout: '', stderr: '', ...(sent.length > 1 ? { warning: 'Committed, but…' } : {}) }
    ),
  },
});
const { native } = await import('../src/lib/native.ts');
const { CommitBox, CommitPick, useCommitDraft } = await import('../src/components/panels/ChangesCommit.tsx');

const file = (path: string, over: object = {}) => ({ path, lines: [], added: 1, removed: 0, ...over });

/** The box and a tick for each listed file, as the Changes pane draws them; `files` can change between renders. */
function Pane({ files }: { files: any[] }) {
  const draft = useCommitDraft('/repo');
  return createElement(
    'div',
    null,
    files.map((f, i) => createElement(CommitPick, { key: `${f.path}-${i}`, draft, path: f.path })),
    createElement(CommitBox, {
      commit: (m: string, f: any) => native.git.commitFiles('/repo', m, f),
      files,
      draft,
      live: () => true,
      done: () => {},
    }),
  );
}

test('a path listed twice is one file; an unticked file that left the list still keeps the commit to the ticked ones', async () => {
  const both = [file('t', { isDeleted: true }), file('t', { isNew: true }), file('o'), file('x')];
  const v = await render(createElement(Pane, { files: both }));
  const button = () => v.host.querySelector('.cp-commit button') as HTMLButtonElement;
  const ticks = () => [...v.host.querySelectorAll('.cp-file-pick')] as HTMLInputElement[];
  await type(v.host.querySelector('.cp-commit input'), 'm');
  assert.equal(button().textContent?.trim(), 'Commit');
  await click(ticks()[3]);
  assert.equal(button().textContent?.trim(), 'Commit 2 of 3');
  // x is reverted, so no longer listed: every listed file is ticked, but the commit still names them
  await act(async () => v.rerender(createElement(Pane, { files: both.slice(0, 3) })));
  assert.equal(button().textContent?.trim(), 'Commit 2 of 2');
  await click(button());
  await flush();
  assert.deepEqual(sent[0][2], [
    { path: 't', oldPath: undefined, isCopy: undefined, isDeleted: true },
    { path: 't', oldPath: undefined, isCopy: undefined, isDeleted: undefined },
    { path: 'o', oldPath: undefined, isCopy: undefined, isDeleted: undefined },
  ]);
  assert.deepEqual(toasts.at(-1), ['Committed 2 files', 'success']);
  // committed, but main couldn't update the index: its warning is what the user is told
  await type(v.host.querySelector('.cp-commit input'), 'again');
  await click(button());
  await flush();
  assert.deepEqual(toasts.at(-1), ['Committed, but…', 'info']);
  await v.unmount();
});
