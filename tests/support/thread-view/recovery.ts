// Conversation-view UI unit cases for recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, settle, setStore, callsTo, moduleCalls, native, flush, T, user, turn, chat, view } from './fixture.ts';

export function registerRecovery() {
  test('rapid Undo clicks apply one patch and allow Restore after completion', async () => {
    let release!: (value: any) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    let reads = 0;
    native.git = {
      applyPatch: async () => {
        reads++;
        return pending;
      },
    };
    chat([
      turn('t1', [
        user('u', 'edit'),
        { id: 'f', type: 'fileChange', status: 'completed', changes: [{ path: '/repo/f.txt', kind: 'add', diff: 'x\n' }] },
      ]),
    ]);
    const v = await render(view());
    const card = () => v.$('[data-stub="EditedFilesCard"]')!;
    try {
      await settle(() => {
        card().querySelector<HTMLElement>('.undo')!.click();
        card().querySelector<HTMLElement>('.undo')!.click();
      });
      assert.equal(reads, 1);
      assert.equal(card().dataset.busy, 'true');
    } finally {
      await settle(() => release({ ok: true }));
    }
    assert.equal(card().dataset.busy, 'false');
    assert.equal(card().dataset.undone, 'true');
    await settle(() => card().querySelector<HTMLElement>('.undo')!.click());
    assert.equal(reads, 2);
    assert.equal(card().dataset.undone, 'false');
    await v.unmount();
  });

  test('rejected Undo and Restore requests clear busy state and preserve the current result for retry', async () => {
    const applied: boolean[] = [];
    let reject = true;
    native.git = {
      applyPatch: async (_cwd: string, _patch: string, reverse: boolean) => {
        applied.push(reverse);
        if (reject) throw new Error('Git unavailable');
        return { ok: true };
      },
    };
    chat([
      turn('t1', [
        user('u', 'edit'),
        { id: 'f', type: 'fileChange', status: 'completed', changes: [{ path: '/repo/f.txt', kind: 'add', diff: 'x\n' }] },
      ]),
    ]);
    const v = await render(view());
    const card = () => v.$('[data-stub="EditedFilesCard"]')!;
    for (const undone of [false, true]) {
      reject = true;
      await settle(() => card().querySelector<HTMLElement>('.undo')!.click());
      assert.equal(card().dataset.busy, 'false');
      assert.equal(card().dataset.undone, String(undone));
      assert.deepEqual(callsTo('store:toast').at(-1), [`Couldn't ${undone ? 'restore' : 'undo'}: Git unavailable`, 'error']);
      reject = false;
      await settle(() => card().querySelector<HTMLElement>('.undo')!.click());
      assert.equal(card().dataset.undone, String(!undone));
    }
    assert.deepEqual(applied, [true, true, false, false]);
    await v.unmount();
  });

  for (const kind of ['add', 'delete']) {
    test(`Undo for an empty ${kind} file has only a mode record`, async () => {
      let applied = '';
      native.git = {
        applyPatch: async (_cwd: string, patch: string) => {
          applied = patch;
          return { ok: true };
        },
      };
      chat([
        turn('t1', [
          user('u', 'edit'),
          { id: 'f', type: 'fileChange', status: 'completed', changes: [{ path: '/repo/empty.txt', kind, diff: '' }] },
        ]),
      ]);
      const v = await render(view());
      try {
        await settle(() => v.$('[data-stub="EditedFilesCard"] .undo')!.click());
        assert.equal(applied, `diff --git a/empty.txt b/empty.txt\n${kind === 'add' ? 'new' : 'deleted'} file mode 100644\n`);
      } finally {
        await v.unmount();
      }
    });
  }

  test('Undo without patch data reports unavailable and never calls applyPatch', async () => {
    let applied = 0;
    native.git = {
      applyPatch: async () => {
        applied++;
        return { ok: true };
      },
    };
    chat([
      turn('t1', [
        user('u', 'edit'),
        { id: 'f', type: 'fileChange', status: 'completed', changes: [{ path: '/repo/f.txt', kind: 'update' }] },
      ]),
    ]);
    const v = await render(view());
    try {
      await settle(() => v.$('[data-stub="EditedFilesCard"] .undo')!.click());
      assert.equal(applied, 0);
      assert.equal(v.$('[data-stub="EditedFilesCard"]')!.dataset.busy, 'false');
      assert.equal(v.$('[data-stub="EditedFilesCard"]')!.dataset.undone, 'false');
      assert.deepEqual(callsTo('store:toast').at(-1), ["Couldn't undo: No patch data is available", 'error']);
    } finally {
      await v.unmount();
    }
  });

  test('blank apply diagnostics keep Undo available for retry without changing its result', async () => {
    native.git = { applyPatch: async () => ({ ok: false, stderr: '' }) };
    chat([
      turn('t1', [
        user('u', 'edit'),
        { id: 'f', type: 'fileChange', status: 'completed', changes: [{ path: '/repo/f.txt', kind: 'add', diff: 'x\n' }] },
      ]),
    ]);
    const v = await render(view());
    try {
      await settle(() => v.$('[data-stub="EditedFilesCard"] .undo')!.click());
      assert.equal(v.$('[data-stub="EditedFilesCard"]')!.dataset.busy, 'false');
      assert.equal(v.$('[data-stub="EditedFilesCard"]')!.dataset.undone, 'false');
      assert.deepEqual(callsTo('store:toast').at(-1), ["Couldn't undo: Patch could not be applied", 'error']);
    } finally {
      await v.unmount();
    }
  });

  test('arrival state belongs to its chat and turn when item ids repeat', async () => {
    const first = turn('arrival-first', [user('arrival-shared-id', 'History')]);
    const second = turn('arrival-second', [user('arrival-shared-id', 'Live message')], { status: 'inProgress' });
    chat([first]);
    const v = await render(view());
    try {
      assert.equal(v.$$('.item-enter .user-message').length, 0);
      await flush();
      await settle(() => chat([first, second], { activeTurnId: second.id }));
      assert.equal(v.$$('.item-enter .user-message').length, 1, 'the new turn must have its own arrival decision');
      setStore({
        threads: { other: { id: 'other', cwd: '/repo' } },
        runtime: { other: { loaded: true, turns: [second], activeTurnId: second.id } },
      });
      await v.rerender(view({ threadId: 'other' }));
      assert.equal(v.$$('.user-message').length, 1);
      assert.equal(v.$$('.item-enter .user-message').length, 0, 'opening another chat renders its existing row as history');
    } finally {
      await v.unmount();
    }
  });

  test('Undo completion belongs to its original chat folder and card lifetime', async () => {
    for (const change of ['folder', 'returned', 'chat', 'unmount']) {
      for (const outcome of ['success', 'failure', 'rejected']) {
        let release!: (value: any) => void;
        let reject!: (error: Error) => void;
        const applied: any[] = [];
        native.git = {
          applyPatch: (...args: any[]) => {
            applied.push(args);
            return new Promise((resolve, fail) => {
              release = resolve;
              reject = fail;
            });
          },
        };
        const turns = [
          turn('undo-lifetime', [
            user('u', 'edit'),
            { id: 'f', type: 'fileChange', status: 'completed', changes: [{ path: 'f.txt', kind: 'add', diff: 'x\n' }] },
          ]),
        ];
        chat(turns);
        const v = await render(view());
        const card = () => v.$('[data-stub="EditedFilesCard"]')!;
        try {
          await settle(() => card().querySelector<HTMLElement>('.undo')!.click());
          assert.equal(applied[0][0], '/repo');
          assert.equal(card().dataset.busy, 'true');
          if (change === 'unmount') await v.unmount();
          else if (change === 'chat') {
            setStore({ threads: { other: { id: 'other', cwd: '/repo' } }, runtime: { other: { loaded: true, turns } } });
            await v.rerender(view({ threadId: 'other' }));
          } else {
            await settle(() => chat(turns, {}, { id: T, cwd: '/other' }));
            assert.equal(card().dataset.busy, 'false', 'a new folder must not inherit a pending Undo');
            if (change === 'returned') await settle(() => chat(turns));
          }
          moduleCalls.length = 0;
          await settle(() =>
            outcome === 'rejected'
              ? reject(new Error('old patch refused'))
              : release(outcome === 'success' ? { ok: true } : { ok: false, stderr: 'old patch refused' }),
          );
          assert.deepEqual(callsTo('store:toast'), [], 'obsolete cards must not show patch feedback');
          if (change !== 'unmount') {
            // a patch that went through changed the disk: the turn says so (#1939), whichever card shows it now
            const applied = outcome === 'success' && change !== 'chat';
            assert.equal(card().dataset.undone, String(applied));
            assert.equal(card().dataset.busy, 'false');
          }
        } finally {
          release({ ok: true });
          if (change !== 'unmount') await v.unmount();
        }
      }
    }
  });
}
