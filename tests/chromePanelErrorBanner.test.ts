// The side panel's error banner (B6): text, a Retry link that runs the failed action once, a dismiss X, and one banner at a time above the composer.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { HTMLElement, HTMLButtonElement } from 'happy-dom';
import { window } from './support/dom.ts';
import { tick } from './support/extension-background/fixture.ts';
import { PanelErrors } from '../electron/chrome-extension/src/panelErrors.mjs';
import { PanelBanners, BANNERS } from '../electron/chrome-extension/src/panelBanners.mjs';

afterEach(() => window.document.body.replaceChildren());

function banner() {
  const doc = window.document;
  doc.body.innerHTML = '<div id="error" hidden></div>';
  const errors = new PanelErrors(doc);
  const root = doc.getElementById('error')! as HTMLElement;
  const retry = () => root.querySelector<HTMLButtonElement>('.banner-retry');
  const dismiss = () => root.querySelector<HTMLButtonElement>('.banner-dismiss')!;
  return { errors, root, retry, dismiss };
}

test('an error with no retry is its text and a dismiss X; the X clears it and hides the banner', () => {
  const b = banner();
  b.errors.show("That chat isn't in MoPilot.");
  assert.equal(b.root.hidden, false);
  assert.equal(b.root.textContent, "That chat isn't in MoPilot.", 'the X draws no text, so the line is only the message');
  assert.equal(b.retry(), null);
  assert.equal(b.dismiss().getAttribute('aria-label'), 'Dismiss error');
  b.dismiss().click();
  assert.equal(b.root.hidden, true);
  assert.equal(b.root.textContent, '');
});

test('Retry hides the banner and runs the failed action once, however often it is pressed', async () => {
  const b = banner();
  let runs = 0;
  b.errors.show("MoPilot isn't connected.", () => void runs++);
  const link = b.retry()!;
  assert.equal(link.textContent, 'Retry');
  link.click();
  link.click();
  assert.equal(b.root.hidden, true, 'the banner goes before the action runs');
  await tick();
  assert.equal(runs, 1);
  link.click();
  await tick();
  assert.equal(runs, 1, 'a press on the link after the banner went runs nothing');
});

test('a new message takes the retry of the one before it; an empty message offers none; the failed action reports its own failure', async () => {
  const b = banner();
  let first = 0;
  b.errors.show('First', () => void first++);
  b.errors.show('Second');
  assert.equal(b.retry(), null, "a later error without a retry does not keep the earlier error's");
  b.errors.show('', () => void first++);
  assert.equal(b.root.hidden, true);
  assert.equal(b.retry(), null);
  b.errors.show('Third', 'not a function' as any);
  assert.equal(b.retry(), null);
  assert.equal(first, 0);
  // the action throws, rejects with an Error, or rejects with a plain value: its text is the new error
  for (const [fail, text] of [
    [
      () => {
        throw new Error('threw');
      },
      'threw',
    ],
    [() => Promise.reject(new Error('rejected')), 'rejected'],
    [() => Promise.reject('plain'), 'plain'],
  ] as const) {
    b.errors.show('Again', fail);
    b.retry()!.click();
    await tick();
    assert.equal(b.root.textContent, text);
    assert.equal(b.retry(), null);
  }
});

test("a retained failed message keeps its own Dismiss and leaves the error's Retry alone", async () => {
  const b = banner();
  let runs = 0;
  b.errors.failed('Not connected', 'kept words', false);
  b.errors.show('Load failed', () => void runs++);
  assert.equal(b.root.querySelectorAll('details').length, 1);
  assert.ok(b.retry(), 'the retained message is a block of its own; the banner line still has Retry');
  const details = b.root.querySelector('details')!;
  details.querySelectorAll('button')[1].click();
  assert.equal(b.root.querySelectorAll('details').length, 0);
  assert.ok(b.retry(), "dismissing the retained message does not retire the error's Retry");
  b.dismiss().click();
  assert.equal(b.root.hidden, true);
  b.errors.failed('Again', 'second', false);
  assert.equal(b.root.hidden, false, 'a retained message alone keeps the banner open');
  assert.equal(b.root.querySelector('.banner-line'), null, 'with no error text there is no line, so no X or Retry');
  b.root.querySelectorAll('button')[1].click();
  assert.equal(b.root.hidden, true);
  await tick();
  assert.equal(runs, 0);
});

test('a message that is back in the composer takes the retry the sender offers; one kept outside it never does', async () => {
  const b = banner();
  let runs = 0;
  b.errors.failed('Not connected', 'text', true, () => void runs++);
  assert.ok(b.retry());
  b.retry()!.click();
  await tick();
  assert.equal(runs, 1);
  b.errors.failed('Not connected', 'text', false, () => void runs++);
  assert.equal(b.retry(), null);
  assert.equal(runs, 1);
});

function banners(hidden: Record<string, boolean>, ids: string[] = BANNERS) {
  const doc = window.document;
  doc.body.innerHTML = ids.map((id) => `<div id="${id}"${hidden[id] === false ? '' : ' hidden'}></div>`).join('');
  const el = (id: string) => doc.getElementById(id)! as HTMLElement;
  return { el, yielded: () => BANNERS.filter((id) => doc.getElementById(id)?.hasAttribute('data-yielded')) };
}

test("banners show in Claude's order, one at a time: the error, then the usage limit, then the tab note", async () => {
  const b = banners({ usage: false, notice: false });
  const shown = new PanelBanners(window as any);
  assert.deepEqual(b.yielded(), ['notice'], 'the usage limit shows; the tab note yields');
  b.el('error').hidden = false;
  await tick();
  assert.deepEqual(b.yielded(), ['usage', 'notice'], 'an error that arrives takes the slot');
  b.el('usage').hidden = true;
  await tick();
  assert.deepEqual(b.yielded(), ['notice'], 'a hidden banner never yields, and the note still waits behind the error');
  b.el('error').hidden = true;
  await tick();
  assert.deepEqual(b.yielded(), [], 'the note shows once nothing is above it');
  b.el('usage').hidden = false;
  await tick();
  assert.deepEqual(b.yielded(), ['notice']);
  shown.close();
  b.el('error').hidden = false;
  await tick();
  assert.deepEqual(b.yielded(), ['notice'], 'a closed coordinator no longer follows the banners');
});

test('a page without every banner coordinates the ones it has', async () => {
  const b = banners({ error: false, usage: false }, ['error', 'usage']);
  const shown = new PanelBanners(window as any);
  assert.deepEqual(b.yielded(), ['usage']);
  shown.close();
});
