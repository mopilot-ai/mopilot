// Diff-panel UI unit cases for diff comments: adding one to the chat's composer and showing pending ones under their lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store, act, mount, settle } from './fixture.ts';

export function registerComments() {
  test("a diff comment goes to the pane chat's composer without taking focus, and pending ones show under their lines", async () => {
    const r = await mount({ scope: 'uncommitted' }, 't1');
    const button = r.host.querySelector<HTMLElement>('[data-inline="src/a.ts"] [data-comment]')!;
    assert.equal(button.getAttribute('data-comment'), 'src/a.ts');
    assert.equal(button.getAttribute('data-workspace'), '/repo');
    // an open composer takes it from the event, and is asked not to take focus
    const seen: any[] = [];
    const take = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      seen.push({ threadId: detail.threadId, focus: detail.focus, diff: detail.attachment.diff, annotation: detail.attachment.annotation });
      detail.handled = true;
    };
    window.addEventListener('composer-add-selection', take);
    await act(async () => button.click());
    window.removeEventListener('composer-add-selection', take);
    assert.deepEqual(seen, [
      {
        threadId: 't1',
        focus: false,
        diff: { path: 'src/a.ts', workspace: '/repo', startSide: 'R', startLine: 2, endSide: 'R', endLine: 2, hunk: '+new' },
        annotation: 'rename',
      },
    ]);
    assert.equal(store.calls.filter((c) => c[0] === 'setDraft').length, 0);
    // with no composer open, the chat's stored draft takes it, and the pane shows it under its line
    store.set({ drafts: { t1: { text: 'typed', attachments: [{ kind: 'file', path: '/x', name: 'x' }] } } });
    await act(async () => button.click());
    await settle(act);
    const draft = store.get().drafts.t1;
    assert.equal(draft.text, 'typed');
    assert.deepEqual(
      draft.attachments.map((a: any) => a.name),
      ['x', 'Diff comment'],
    );
    const notes = () => [...r.host.querySelectorAll('[data-inline="src/a.ts"] [data-note-line]')];
    assert.equal(notes().length, 1);
    assert.equal(notes()[0].getAttribute('data-note-line'), '2');
    assert.equal(notes()[0].getAttribute('data-note-side'), 'R');
    assert.equal(notes()[0].querySelector('.diff-comment-text')!.textContent, 'rename');
    // other files, and the same path in another folder, show none
    assert.equal(r.host.querySelectorAll('[data-inline="new.py"] [data-note-line]').length, 0);
    const elsewhere = { ...draft.attachments[1], annotationId: 'other', diff: { ...draft.attachments[1].diff, workspace: '/other' } };
    const noWorkspace = { ...draft.attachments[1], annotationId: 'bare', diff: { ...draft.attachments[1].diff, workspace: undefined } };
    store.set({ drafts: { t1: { text: '', attachments: [elsewhere, noWorkspace] } } });
    await settle(act);
    assert.equal(notes().length, 1);
    // sending empties the draft, and the pending comment goes with it
    store.set({ drafts: { t1: { text: '', attachments: [] } } });
    await settle(act);
    assert.equal(notes().length, 0);
  });

  test('with no chat, comments go to the new-chat composer, and two added at once both stay', async () => {
    store.set({ drafts: {} });
    const r = await mount({ scope: 'uncommitted' }, null);
    const buttons = [...r.host.querySelectorAll<HTMLElement>('[data-comment]')];
    // two comments before the pane re-renders with the first one's draft
    await act(async () => {
      buttons[0].click();
      buttons[1].click();
    });
    assert.deepEqual(
      store.get().drafts.home.attachments.map((a: any) => a.diff.path),
      ['src/a.ts', 'new.py'],
    );
    assert.equal(store.get().drafts.home.text, '');
  });
}
