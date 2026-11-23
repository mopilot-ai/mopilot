// Failed panel messages remain independently copyable until dismissal, across transient notices and navigation.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { HTMLElement, HTMLButtonElement } from 'happy-dom';
import { window } from './support/dom.ts';
import { PanelErrors } from '../electron/chrome-extension/src/panelErrors.mjs';

afterEach(() => window.document.body.replaceChildren());

test('recoveries combine independent messages and survive notices without detaching existing disclosures', () => {
  const doc = window.document;
  doc.body.innerHTML = '<div id="error"></div>';
  const errors = new PanelErrors(doc);
  const root = doc.getElementById('error')! as HTMLElement;
  errors.failed('First failed', '<literal message>', false);
  const first = root.querySelector('details')!;
  assert.equal(first.open, true, 'the failure reason and Copy are visible immediately');
  errors.show('Other action failed');
  assert.equal(root.querySelector('details'), first);
  assert.equal(first.open, true);
  assert.match(root.textContent, /Other action failed/);
  errors.show('');
  errors.show('Independent current notice');
  errors.failed('Second failed', 'Second text', false);
  assert.match(root.textContent, /Independent current notice/);
  assert.equal(root.querySelectorAll('details').length, 2);
  const copies = [...root.querySelectorAll<HTMLButtonElement>('[data-panel-copy]')];
  assert.deepEqual(
    copies.map((b) => b.dataset.panelCopy),
    ['<literal message>', 'Second text'],
  );
  assert.equal(first.querySelector('pre')!.textContent, 'Message: <literal message>');
  assert.equal(first.querySelector('literal'), null);
  const dismiss = first.querySelectorAll('button')[1];
  dismiss.click();
  assert.doesNotMatch(root.textContent, /First failed/);
  assert.match(root.textContent, /Second text/);
  root.querySelectorAll('button')[2].click();
  assert.equal(root.textContent, 'Independent current notice');
  errors.show('');
  assert.equal(root.hidden, true);
  errors.failed('Still in composer', 'Editable draft', true);
  assert.equal(root.textContent, 'Still in composer');
  assert.equal(root.hidden, false);
  errors.show('');
  assert.equal(root.hidden, true);
});
