// src/store/rewindFiles.ts through revertThread (src/store/actions.ts): a Codex chat's rewind restores its folder's files after asking with them listed, rewinds only the conversation when the turn has no checkpoint, puts the files back when the conversation can't be rewound, and offers Undo.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const texts = () => st().toasts.map((t) => t.text);
let answer = true;
const asked: string[] = [];
(globalThis as any).confirm = (q: string) => (asked.push(q), answer);

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  answer = true;
  asked.length = 0;
  impl['session.snapshot'] = async () => null;
  impl['codex.leased'] = async () => ({ result: {} });
  impl['checkpoints.plan'] = async () => ({ ok: true, files: ['src/a.ts', 'b.md'] });
  impl['checkpoints.restore'] = async () => ({ ok: true, restored: 2, undo: 'u-1' });
  impl['checkpoints.undo'] = async () => ({ ok: true, restored: 2 });
  set({
    threads: { r: { id: 'r', cwd: '/w/p', updatedAt: 1 } as any },
    runtime: { r: { turns: [{ id: 'a' }, { id: 'b' }] } as any },
  });
});

test('the files are listed and asked about, restored, then the conversation is rewound; Undo puts the files back', async () => {
  assert.equal(await S.revertThread('r', 'b'), true);
  assert.deepEqual(callsOf('checkpoints.plan'), [['r', 'b', '/w/p']]);
  assert.match(asked[0], /restores 2 files to how they were before this message:\n\nsrc\/a\.ts\nb\.md\n/);
  assert.deepEqual(callsOf('checkpoints.restore'), [['r', 'b', '/w/p', ['src/a.ts', 'b.md']]]);
  assert.equal(callsOf('codex.leased').length, 1);
  assert.equal(texts().at(-1), 'Restored 2 files');
  st().toasts.at(-1)!.action!.run();
  await flush();
  assert.deepEqual(callsOf('checkpoints.undo'), [['r', '/w/p', 'u-1']]);
  assert.equal(texts().at(-1), 'Put the files back');
  // one file says so in the singular
  impl['checkpoints.plan'] = async () => ({ ok: true, files: ['src/a.ts'] });
  impl['checkpoints.restore'] = async () => ({ ok: true, restored: 1, undo: 'u-9' });
  assert.equal(await S.revertThread('r', 'b'), true);
  assert.equal(texts().at(-1), 'Restored 1 file');
});

test('saying no rewinds nothing; a long list is cut, and the question says what else a restore does', async () => {
  answer = false;
  impl['checkpoints.plan'] = async () => ({ ok: true, files: Array.from({ length: 10 }, (_, i) => `f${i}`) });
  assert.equal(await S.revertThread('r', 'b'), false);
  assert.equal(st().threads.r.recencyAt, undefined);
  assert.match(asked[0], /f7\n…and 2 more\n\nEdits made to them since, by anyone, are undone too\. Commits stay/);
  assert.deepEqual([callsOf('checkpoints.restore'), callsOf('codex.leased')], [[], []]);
  impl['checkpoints.plan'] = async () => ({ ok: true, files: ['one'] });
  await S.revertThread('r', 'b');
  assert.match(asked[1], /restores 1 file to/);
});

test('a successful rewind of a retired native segment leaves the current chat activity alone', async () => {
  impl['codex.leased'] = async () => {
    set({
      segments: {
        r: [
          { harness: 'codex', nativeId: 'r' },
          { harness: 'claude', nativeId: 'claude:next' },
        ],
      } as any,
    });
    return { result: {} };
  };
  assert.equal(await S.revertThread('r', 'b'), false);
  assert.equal(st().threads.r.recencyAt, undefined);
  assert.deepEqual(
    st().runtime.r.turns.map((turn) => turn.id),
    ['a', 'b'],
  );
});

test('a turn with no checkpoint, or one that changed ignore rules, or no files to restore, rewinds the conversation only, said after', async () => {
  for (const [none, said] of [
    ['checkpoint', 'Only the conversation was rewound: this message has no file checkpoint, so its files are as they were.'],
    ['ignores', 'Only the conversation was rewound: this turn changed which files are ignored, so its files can’t be restored safely.'],
  ] as const) {
    impl['checkpoints.plan'] = async () => ({ ok: true, none });
    assert.equal(await S.revertThread('r', 'b'), true);
    assert.equal(texts().at(-1), said);
  }
  // the conversation refused: no note that it was rewound
  set({ toasts: [] });
  impl['codex.leased'] = async () => ({ locked: true });
  assert.equal(await S.revertThread('r', 'b'), false);
  assert.equal(
    texts().some((t) => t.startsWith('Only the conversation')),
    false,
  );
  impl['codex.leased'] = async () => ({ result: {} });
  impl['checkpoints.plan'] = async () => ({ ok: true, files: [] });
  assert.equal(await S.revertThread('r', 'a'), true);
  assert.deepEqual([asked, callsOf('checkpoints.restore')], [[], []]);
  // and a chat with no folder asks main nothing
  set({ threads: {} });
  assert.equal(await S.revertThread('r', 'a'), true);
  assert.equal(callsOf('checkpoints.plan').length, 4);
});

test('a plan or restore that fails stops the rewind with why; a conversation that can’t be rewound gets its files back', async () => {
  impl['checkpoints.plan'] = async () => ({ ok: false, error: 'Stop the running turn first.' });
  assert.equal(await S.revertThread('r', 'b'), false);
  assert.equal(texts().at(-1), "Couldn't rewind: Stop the running turn first.");
  impl['checkpoints.plan'] = () => Promise.reject(new Error('gone'));
  assert.equal(await S.revertThread('r', 'b'), false);
  assert.equal(texts().at(-1), "Couldn't rewind: gone");
  impl['checkpoints.plan'] = async () => ({ ok: true, files: ['a'] });
  impl['checkpoints.restore'] = async () => ({ ok: false, error: 'Some files couldn’t be restored.' });
  assert.equal(await S.revertThread('r', 'b'), false);
  assert.equal(texts().at(-1), 'Couldn’t restore the files: Some files couldn’t be restored.'.replace('Couldn’t', "Couldn't"));
  // left half restored, with the undo handed back: the error offers it
  impl['checkpoints.restore'] = async () => ({ ok: false, error: 'Some files couldn’t be restored.', undo: 'u-3' });
  assert.equal(await S.revertThread('r', 'b'), false);
  st().toasts.at(-1)!.action!.run();
  await flush();
  assert.deepEqual(callsOf('checkpoints.undo').at(-1), ['r', '/w/p', 'u-3']);
  impl['checkpoints.restore'] = () => Promise.reject(new Error('x'));
  assert.equal(await S.revertThread('r', 'b'), false);
  assert.equal(callsOf('codex.leased').length, 0);
  // restored, then the conversation was refused: the files go back
  impl['checkpoints.restore'] = async () => ({ ok: true, restored: 1, undo: 'u-2' });
  impl['codex.leased'] = async () => ({ locked: true });
  impl['checkpoints.undo'] = async () => ({ ok: false, error: 'There is nothing to undo.' });
  assert.equal(await S.revertThread('r', 'b'), false);
  assert.deepEqual(callsOf('checkpoints.undo').at(-1), ['r', '/w/p', 'u-2']);
  assert.equal(texts().at(-1), "Couldn't put the files back: There is nothing to undo.");
  impl['checkpoints.undo'] = () => Promise.reject(new Error('down'));
  assert.equal(await S.revertThread('r', 'b'), false);
  assert.equal(texts().at(-1), "Couldn't put the files back: down");
});
