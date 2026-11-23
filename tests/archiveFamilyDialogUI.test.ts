// The global family-archive dialog serializes requests, keeps stale answers inert, and cancels pending input on teardown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ArchiveFamilyDialog } from '../src/components/dialogs/ArchiveFamilyDialog.tsx';
import {
  answerArchiveFamilyChoice,
  cancelArchiveFamilyChoices,
  requestArchiveFamilyChoice,
  useArchiveFamilyChoice,
} from '../src/lib/archiveFamilyChoice.ts';

test('archive choices show the whole family, default to parent only, and serialize independent requests', async () => {
  cancelArchiveFamilyChoices();
  answerArchiveFamilyChoice(-1, 'all');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as never);
  let currentId = 0;
  function Owner() {
    const request = useArchiveFamilyChoice();
    if (request) currentId = request.id;
    return createElement(ArchiveFamilyDialog);
  }
  await act(async () => root.render(createElement(Owner)));
  const click = async (text: string) =>
    act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement).click());
  try {
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = requestArchiveFamilyChoice({ title: 'Parent', total: 2, working: 0 });
      second = requestArchiveFamilyChoice({ title: 'Next', total: 4, working: 2 });
    });
    assert.equal(host.querySelector('[role="alertdialog"]') !== null, true);
    assert.match(host.textContent!, /“Parent” has a nested session\. Archive only this one and it moves to the top level\./);
    const staleId = currentId;
    await click('Archive 2 sessions');
    assert.equal(await first, 'all');
    assert.match(host.textContent!, /“Next” has 3 nested sessions/);
    assert.match(host.textContent!, /2 nested sessions are still working/);
    await act(async () => answerArchiveFamilyChoice(staleId, 'parent'));
    assert.match(host.textContent!, /“Next”/, 'a stale button does not answer the next request');
    await click('Archive this session');
    assert.equal(await second, 'parent');
    assert.equal(host.querySelector('[role="alertdialog"]'), null);

    let canceled!: Promise<unknown>;
    await act(async () => {
      canceled = requestArchiveFamilyChoice({ title: 'Working', total: 3, working: 1 });
    });
    assert.match(host.textContent!, /A nested session is still working and stops if you archive it too\./);
    assert.ok(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Archive all 3 sessions'));
    await act(async () =>
      host.querySelector('.sketch-backdrop')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    assert.ok(host.querySelector('[role="alertdialog"]'));
    await act(async () =>
      host
        .querySelector('.sketch-backdrop')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })),
    );
    assert.ok(host.querySelector('[role="alertdialog"]'), 'IME escape leaves the choice open');
    await act(async () =>
      host.querySelector('.sketch-backdrop')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    assert.equal(await canceled, null);
    await act(async () => {
      canceled = requestArchiveFamilyChoice({ title: 'Cancel button', total: 2, working: 0 });
    });
    await click('Cancel');
    assert.equal(await canceled, null);

    let queued!: Promise<unknown>;
    await act(async () => {
      canceled = requestArchiveFamilyChoice({ title: 'Dispose', total: 2, working: 0 });
      queued = requestArchiveFamilyChoice({ title: 'Queued', total: 2, working: 0 });
    });
    await act(async () => root.unmount());
    assert.deepEqual(await Promise.all([canceled, queued]), [null, null]);
  } finally {
    cancelArchiveFamilyChoices();
    await act(async () => root.unmount());
    host.remove();
  }
});
