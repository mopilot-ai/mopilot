// src/lib/diffReview.ts and src/lib/diffViewed.ts: whitespace-only edits set aside, the diff fingerprint, and Viewed
// marks kept per folder against it, bounded, saved, read back across windows, and safe with broken storage.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render } from './support/shell-panels-kit.ts';
import { parseUnifiedDiff, reuseDiffFiles } from '../src/lib/diff.ts';
import { diffFingerprint, sameReviewLines, whitespaceOnly, withoutWhitespaceChanges } from '../src/lib/diffReview.ts';
import {
  VIEWED_FILES_MAX,
  VIEWED_FOLDERS_MAX,
  VIEWED_STORAGE_PREFIX,
  resetViewedMarks,
  setViewed,
  useViewedVersion,
  viewedState,
} from '../src/lib/diffViewed.ts';

const file = (...body: string[]) =>
  parseUnifiedDiff(['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ...body].join('\n'))[0];

beforeEach(() => {
  localStorage.clear();
  resetViewedMarks();
});

test('a removed and added line that differ only in whitespace become one unchanged line; real edits stay in order', () => {
  const f = file('-a  =  1', '-gone', '+a = 1', '+changed', '+extra', ' tail');
  const out = withoutWhitespaceChanges(f);
  assert.deepEqual(
    out.lines.filter((l) => l.kind !== 'hunk').map((l) => `${l.kind}:${l.text}:${l.oldNo ?? ''}:${l.newNo ?? ''}`),
    ['ctx:a = 1:1:1', 'del:gone:2:', 'add:changed::2', 'add:extra::3', 'ctx:tail:3:4'],
  );
  assert.deepEqual([out.added, out.removed], [2, 1]);
  assert.equal(withoutWhitespaceChanges(f), out, 'the same file gives back the same object');
  const plain = file('-one', '+two');
  assert.equal(withoutWhitespaceChanges(plain), plain, 'nothing set aside: the file itself');
  const onlyAdds = file('+x', ' y');
  assert.equal(withoutWhitespaceChanges(onlyAdds), onlyAdds);
});

test('a file is whitespace only when it changed and nothing is left without whitespace', () => {
  assert.equal(whitespaceOnly(file('-\tif (a) {', '+    if (a) {')), true);
  assert.equal(whitespaceOnly(file('-a', '+b')), false);
  assert.equal(whitespaceOnly({ path: 'x', lines: [], added: 0, removed: 0 }), false);
  assert.equal(whitespaceOnly({ path: 'x', lines: [], added: 1, removed: 1, binary: true }), false);
});

test('the fingerprint follows what the diff says', () => {
  assert.equal(diffFingerprint(file('-a', '+b')), diffFingerprint(file('-a', '+b')));
  assert.notEqual(diffFingerprint(file('-a', '+b')), diffFingerprint(file('-a', '+c')));
});

test('a mark holds for the diff it was made on, reads as changed after, and clears', () => {
  assert.equal(viewedState('/r', 'a.ts', 'f1'), null);
  setViewed('/r', 'a.ts', 'f1');
  assert.equal(viewedState('/r', 'a.ts', 'f1'), 'viewed');
  assert.equal(viewedState('/r', 'a.ts', 'f2'), 'changed');
  assert.equal(viewedState('/other', 'a.ts', 'f1'), null, 'each folder has its own');
  resetViewedMarks();
  assert.equal(viewedState('/r', 'a.ts', 'f1'), 'viewed', 'read back from storage');
  setViewed('/r', 'a.ts', null);
  assert.equal(viewedState('/r', 'a.ts', 'f1'), null);
  assert.equal(localStorage.length, 0, 'a scope with no marks is dropped');
});

test('only the most recent files and folders are kept', () => {
  for (let i = 0; i <= VIEWED_FILES_MAX; i++) setViewed('/r', `f${i}`, 'x');
  assert.equal(viewedState('/r', 'f0', 'x'), null);
  assert.equal(viewedState('/r', `f${VIEWED_FILES_MAX}`, 'x'), 'viewed');
  for (let i = 0; i <= VIEWED_FOLDERS_MAX; i++) setViewed(`/d${i}`, 'a', 'x');
  assert.equal(viewedState('/r', `f${VIEWED_FILES_MAX}`, 'x'), null, 'the oldest folder went');
  assert.equal(viewedState(`/d${VIEWED_FOLDERS_MAX}`, 'a', 'x'), 'viewed');
});

test('malformed storage identities are ignored without losing valid marks', () => {
  localStorage.setItem(VIEWED_STORAGE_PREFIX + JSON.stringify(['/r', 'a']), 'f');
  for (const value of ['not json', '[1,2]', 'null', '["only-one"]']) localStorage.setItem(VIEWED_STORAGE_PREFIX + value, 'broken');
  localStorage.setItem('unrelated', 'value');
  resetViewedMarks();
  assert.equal(viewedState('/r', 'a', 'f'), 'viewed');
  for (const path of ['constructor', '__proto__', 'toString']) assert.equal(viewedState('/r', path, 'f'), null);
});

test('storage that refuses reads or writes keeps marks for this window only', () => {
  const store = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => ({
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    }),
  });
  try {
    resetViewedMarks();
    setViewed('/r', 'a', 'f');
    assert.equal(viewedState('/r', 'a', 'f'), 'viewed');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    resetViewedMarks();
    assert.equal(viewedState('/r', 'a', 'f'), null);
    setViewed('/r', 'a', 'f');
    assert.equal(viewedState('/r', 'a', 'f'), 'viewed');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', store);
    resetViewedMarks();
  }
});

test('a view follows marks made here and in another window, and stops listening when it goes', async () => {
  function Probe() {
    useViewedVersion();
    return h('i', null, viewedState('/r', 'a', 'f') ?? 'none');
  }
  const r = await render(h(Probe));
  assert.equal(r.host.textContent, 'none');
  await act(async () => setViewed('/r', 'a', 'f'));
  assert.equal(r.host.textContent, 'viewed');
  // another window cleared it: its write arrives as a storage event
  localStorage.clear();
  await act(
    async () =>
      void window.dispatchEvent(new (window as any).StorageEvent('storage', { key: VIEWED_STORAGE_PREFIX + JSON.stringify(['/r', 'a']) })),
  );
  assert.equal(r.host.textContent, 'none');
  await act(async () => void window.dispatchEvent(new (window as any).StorageEvent('storage', { key: 'something else' })));
  assert.equal(r.host.textContent, 'none');
  await r.unmount();
});

test('independent windows persist separate entries before their storage events arrive', async () => {
  const other = await import(new URL('../src/lib/diffViewed.ts?other-window', import.meta.url).href);
  assert.equal(viewedState('/r', 'a', '1'), null);
  assert.equal(other.viewedState('/r', 'b', '2'), null);
  setViewed('/r', 'a', '1');
  other.setViewed('/r', 'b', '2');
  resetViewedMarks();
  assert.equal(viewedState('/r', 'a', '1'), 'viewed');
  assert.equal(viewedState('/r', 'b', '2'), 'viewed');
});

test('reopening the pane sees marks another window changed while no consumer was mounted', async () => {
  function Probe() {
    useViewedVersion();
    return h('i', null, viewedState('/r', 'a', 'f') ?? 'none');
  }
  const first = await render(h(Probe));
  await act(async () => setViewed('/r', 'a', 'f'));
  await first.unmount();
  localStorage.removeItem(VIEWED_STORAGE_PREFIX + JSON.stringify(['/r', 'a']));
  window.dispatchEvent(new (window as any).StorageEvent('storage', { key: VIEWED_STORAGE_PREFIX + JSON.stringify(['/r', 'a']) }));
  const reopened = await render(h(Probe));
  assert.equal(reopened.host.textContent, 'none');
  await reopened.unmount();
});

test('PR comment validation tolerates context size but requires matching edits and selected line coordinates', () => {
  const local = parseUnifiedDiff('--- a/x.ts\n+++ b/x.ts\n@@ -2 +2 @@\n-old\n+new')[0];
  const github = parseUnifiedDiff('--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n before\n-old\n+new\n after')[0];
  const range = { path: 'x.ts', startSide: 'R' as const, endSide: 'R' as const, startLine: 2, endLine: 2, hunk: '+new' };
  assert.equal(sameReviewLines(local, github, range), true);
  assert.equal(
    sameReviewLines(local, { ...github, lines: github.lines.map((l) => (l.kind === 'add' ? { ...l, text: 'changed' } : l)) }, range),
    false,
  );
  assert.equal(sameReviewLines(local, github, { ...range, startLine: 1 }), false);
  assert.equal(sameReviewLines(github, local, { ...range, startLine: 1 }), false);
  const wrongContext = { ...github, lines: github.lines.map((l) => (l.kind === 'ctx' ? { ...l, text: 'other' } : l)) };
  assert.equal(sameReviewLines(github, wrongContext, { ...range, startLine: 1 }), false);
});

test('binary blob identities survive parsing, snapshot reuse and Viewed fingerprinting', () => {
  const patch = (id: string) =>
    `diff --git a/image.png b/image.png\nindex aaa111..${id} 100644\nBinary files a/image.png and b/image.png differ\n`;
  const before = parseUnifiedDiff(patch('bbb222'));
  const after = parseUnifiedDiff(patch('ccc333'));
  assert.equal(before[0].binaryVersion, 'aaa111..bbb222 100644');
  assert.notEqual(diffFingerprint(before[0]), diffFingerprint(after[0]));
  assert.notEqual(reuseDiffFiles(before, after), before);
  assert.equal(reuseDiffFiles(before, parseUnifiedDiff(patch('bbb222'))), before);
  const unidentified = parseUnifiedDiff('diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ')[0];
  assert.equal(unidentified.binaryVersion, undefined);
});

test('Viewed storage can be absent or fail while enumerating, without preventing in-memory marks', () => {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
    resetViewedMarks();
    assert.equal(viewedState('/r', 'x', 'f'), null);
    setViewed('/r', 'x', 'f');
    assert.equal(viewedState('/r', 'x', 'f'), 'viewed');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        get length() {
          throw new Error('Storage unavailable');
        },
      },
    });
    resetViewedMarks();
    assert.equal(viewedState('/r', 'x', 'f'), null);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', own);
    resetViewedMarks();
  }
});

test('PR validation checks old-side coordinates independently of the replacement line', () => {
  const f = file('-before', '+after');
  assert.equal(sameReviewLines(f, f, { path: 'x.ts', startSide: 'L', endSide: 'L', startLine: 1, endLine: 1, hunk: '-before' }), true);
});
