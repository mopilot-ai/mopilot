// src/lib/fileDrafts.ts: unsaved edits to side-pane files are kept by path, saved only over the text they started
// from unless the user agrees, never two saves of one file at once, and dropped only when the user agrees.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render } from './support/shell-panels-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { deferred } from './support/async-scenarios.ts';

const disk = new Map<string, string>();
const writes: [string, string][] = [];
let readGate: Promise<void> | null = null;
let writeAnswer: (() => Promise<{ ok: boolean; error?: string }>) | null = null;
installNativeStub({
  fs: {
    readText: async (p: string) => {
      if (readGate) await readGate;
      if (p === '/unreadable') throw new Error('EACCES');
      return disk.get(p) ?? null;
    },
    writeText: async (p: string, text: string) => {
      writes.push([p, text]);
      if (writeAnswer) return writeAnswer();
      disk.set(p, text);
      return { ok: true };
    },
  },
});
const drafts = await import('../src/lib/fileDrafts.ts');
const { setFileDraft, fileDraft, hasDraft, dropFileDraft, confirmDiscard, saveFileDraft, isSavingDraft, resetFileDrafts, useFileDraft } =
  drafts;

beforeEach(() => {
  localStorage.clear();
  resetFileDrafts();
  disk.clear();
  writes.length = 0;
  readGate = null;
  writeAnswer = null;
});
const yes = () => true;
const no = () => false;

test('an edit is a draft against its base; editing back to the base, or dropping it, leaves none', () => {
  setFileDraft('/a', 'one', 'one');
  assert.equal(hasDraft('/a'), false);
  setFileDraft('/a', 'one', 'two');
  assert.deepEqual(fileDraft('/a'), { base: 'one', text: 'two' });
  setFileDraft('/a', 'one', 'two');
  setFileDraft('/a', 'one', 'one');
  assert.equal(fileDraft('/a'), undefined);
  setFileDraft('/a', 'one', 'three');
  dropFileDraft('/a');
  dropFileDraft('/a');
  assert.equal(hasDraft('/a'), false);
});

test('discarding asks only when there are edits; no keeps them, yes drops them', () => {
  const asked: string[] = [];
  assert.equal(
    confirmDiscard(['/a'], () => assert.fail('nothing to ask')),
    true,
  );
  setFileDraft('/a', 'x', 'y');
  setFileDraft('/b', 'x', 'y');
  assert.equal(
    confirmDiscard(['/a'], (m) => (asked.push(m), false)),
    false,
  );
  assert.equal(hasDraft('/a'), true);
  assert.match(asked[0], /this file/);
  assert.equal(
    confirmDiscard(['/a', '/b', '/c'], (m) => (asked.push(m), true)),
    true,
  );
  assert.match(asked[1], /2 files/);
  assert.equal(hasDraft('/a') || hasDraft('/b'), false);
});

test('the default question is the window’s confirm', () => {
  const original = window.confirm;
  (window as any).confirm = () => false;
  try {
    setFileDraft('/a', 'x', 'y');
    assert.equal(confirmDiscard(['/a']), false);
  } finally {
    (window as any).confirm = original;
  }
});

test('saving writes the draft over the file that still holds its base and leaves no draft', async () => {
  disk.set('/a', 'one');
  setFileDraft('/a', 'one', 'two');
  assert.equal(await saveFileDraft('/a', () => assert.fail('the file did not change')), 'saved');
  assert.deepEqual(writes, [['/a', 'two']]);
  assert.equal(hasDraft('/a'), false);
  assert.equal(await saveFileDraft('/a', no), 'saved', 'nothing to save is saved');
  assert.equal(writes.length, 1);
});

test('a file written meanwhile asks before it is replaced: no keeps the draft, yes saves over it', async () => {
  disk.set('/a', 'agent wrote this');
  setFileDraft('/a', 'one', 'mine');
  assert.equal(await saveFileDraft('/a', no), 'kept');
  assert.equal(writes.length, 0);
  assert.equal(hasDraft('/a'), true);
  assert.equal(isSavingDraft('/a'), false);
  assert.equal(await saveFileDraft('/a', yes), 'saved');
  assert.equal(disk.get('/a'), 'mine');
});

test('a save under way makes a second one busy, and either order of finishing leaves one write', async () => {
  disk.set('/a', 'one');
  setFileDraft('/a', 'one', 'two');
  const gate = deferred<void>();
  readGate = gate.promise;
  const first = saveFileDraft('/a', yes);
  assert.equal(isSavingDraft('/a'), true);
  assert.equal(await saveFileDraft('/a', yes), 'busy');
  gate.resolve();
  assert.equal(await first, 'saved');
  assert.equal(writes.length, 1);
});

test('typing during a save keeps the new text as a draft against what was saved', async () => {
  disk.set('/a', 'one');
  setFileDraft('/a', 'one', 'two');
  const gate = deferred<void>();
  readGate = gate.promise;
  const saving = saveFileDraft('/a', yes);
  setFileDraft('/a', 'one', 'three');
  gate.resolve();
  assert.equal(await saving, 'saved');
  assert.deepEqual(writes, [['/a', 'two']]);
  assert.deepEqual(fileDraft('/a'), { base: 'two', text: 'three' });
});

test('an edit discarded while its save reads the file is not written, and stays discarded', async () => {
  disk.set('/a', 'one');
  setFileDraft('/a', 'one', 'two');
  const gate = deferred<void>();
  readGate = gate.promise;
  const saving = saveFileDraft('/a', yes);
  dropFileDraft('/a');
  gate.resolve();
  assert.equal(await saving, 'discarded');
  assert.deepEqual(writes, []);
  assert.equal(hasDraft('/a'), false);
});

test('a refused or failed write, or a failed read, rejects with its reason and keeps the draft to try again', async () => {
  disk.set('/a', 'one');
  setFileDraft('/a', 'one', 'two');
  writeAnswer = async () => ({ ok: false, error: 'EROFS: read-only file system' });
  await assert.rejects(saveFileDraft('/a', yes), /EROFS/);
  writeAnswer = async () => ({ ok: false });
  await assert.rejects(saveFileDraft('/a', yes), /Could not save the file/);
  writeAnswer = async () => {
    throw new Error('');
  };
  await assert.rejects(saveFileDraft('/a', yes), /Could not save the file/);
  assert.equal(hasDraft('/a'), true);
  assert.equal(isSavingDraft('/a'), false);
  setFileDraft('/unreadable', 'x', 'y');
  await assert.rejects(saveFileDraft('/unreadable', yes), /EACCES/);
  writeAnswer = null;
  assert.equal(await saveFileDraft('/a', yes), 'saved', 'a later try succeeds');
});

test('the default save question is the window’s confirm', async () => {
  const original = window.confirm;
  (window as any).confirm = () => false;
  try {
    disk.set('/a', 'changed');
    setFileDraft('/a', 'one', 'two');
    assert.equal(await saveFileDraft('/a'), 'kept');
  } finally {
    (window as any).confirm = original;
  }
});

test('a view of a file’s draft follows edits and saves', async () => {
  function Probe() {
    const { draft, saving } = useFileDraft('/a');
    return h('i', null, `${draft?.text ?? 'none'}|${saving}`);
  }
  const r = await render(h(Probe));
  assert.equal(r.host.textContent, 'none|false');
  await act(async () => setFileDraft('/a', 'one', 'two'));
  assert.equal(r.host.textContent, 'two|false');
  disk.set('/a', 'one');
  await act(async () => void (await saveFileDraft('/a', yes)));
  assert.equal(r.host.textContent, 'none|false');
  await r.unmount();
});

test('drafts are saved on this device: a reload (or quit) gets them back, and another window keeps its own', () => {
  setFileDraft('/a', 'one', 'two');
  // another window saved a draft of another file meanwhile
  const saved = JSON.parse(localStorage.getItem('mopilot.fileDrafts.v1')!);
  localStorage.setItem('mopilot.fileDrafts.v1', JSON.stringify({ ...saved, '/b': { base: 'x', text: 'y' } }));
  setFileDraft('/c', 'p', 'q');
  resetFileDrafts();
  assert.deepEqual(
    [fileDraft('/a'), fileDraft('/b'), fileDraft('/c')],
    [
      { base: 'one', text: 'two' },
      { base: 'x', text: 'y' },
      { base: 'p', text: 'q' },
    ],
  );
  dropFileDraft('/a');
  resetFileDrafts();
  assert.equal(hasDraft('/a'), false);
  assert.equal(hasDraft('/b'), true);
});

test('saved drafts that are malformed read as none, keeping the readable ones', () => {
  localStorage.setItem(
    'mopilot.fileDrafts.v1',
    JSON.stringify({ '/ok': { base: 'a', text: 'b' }, '/same': { base: 'a', text: 'a' }, '/bad': { base: 1 }, '/null': null }),
  );
  resetFileDrafts();
  assert.deepEqual([hasDraft('/ok'), hasDraft('/same'), hasDraft('/bad'), hasDraft('/null')], [true, false, false, false]);
  for (const raw of ['nope', '[1]']) {
    localStorage.setItem('mopilot.fileDrafts.v1', raw);
    resetFileDrafts();
    assert.equal(hasDraft('/ok'), false);
  }
});

test('a draft too large for the device’s room, or storage that refuses it, still holds in this window', () => {
  setFileDraft('/big', 'a', 'x'.repeat(drafts.SAVED_DRAFTS_MAX_CHARS + 1));
  assert.equal(hasDraft('/big'), true);
  assert.equal(localStorage.getItem('mopilot.fileDrafts.v1'), '{}');
  const store = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => ({
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      }),
    });
    setFileDraft('/a', 'one', 'two');
    assert.equal(hasDraft('/a'), true);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    resetFileDrafts();
    setFileDraft('/a', 'one', 'two');
    assert.equal(hasDraft('/a'), true);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', store);
    localStorage.clear();
    resetFileDrafts();
  }
});

test('an edit keeps the file’s Windows line endings, so saving changes none of them and undoing leaves no draft', () => {
  setFileDraft('/w', 'one\r\ntwo', 'one\nTWO');
  assert.equal(fileDraft('/w')?.text, 'one\r\nTWO');
  setFileDraft('/w', 'one\r\ntwo', 'one\ntwo');
  assert.equal(hasDraft('/w'), false);
  setFileDraft('/u', 'one\ntwo', 'one\nTWO');
  assert.equal(fileDraft('/u')?.text, 'one\nTWO');
  assert.equal(drafts.withEndingsOf('a\r\nb', 'x\r\ny\nz'), 'x\r\ny\r\nz');
});

test('a draft another window saved or dropped shows here too', async () => {
  function Probe() {
    const { draft } = useFileDraft('/a');
    return h('i', null, draft?.text ?? 'none');
  }
  const r = await render(h(Probe));
  localStorage.setItem('mopilot.fileDrafts.v1', JSON.stringify({ '/a': { base: 'x', text: 'theirs' } }));
  await act(async () => void window.dispatchEvent(new (window as any).StorageEvent('storage', { key: 'mopilot.fileDrafts.v1' })));
  assert.equal(r.host.textContent, 'theirs');
  await act(async () => void window.dispatchEvent(new (window as any).StorageEvent('storage', { key: 'other' })));
  assert.equal(r.host.textContent, 'theirs');
  await r.unmount();
});
