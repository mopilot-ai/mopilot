// The + menu's Plan mode on a chat on a machine or with an owner not known yet: off, with the reason (#4278).
// with its plugins, the sketch pad, the permission picker, the Full access banner and the voice bar. A basic harness's
// mode picker is in composerModePicker.test.ts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, fire } from './support/composer-kit.ts';
import { fx, last, mountComposer, reset } from './support/composer-setup.ts';

beforeEach(() => reset());
const W = window as any;
const _key = (k: string) => fire(window, new W.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const item = (title: string) => $$('.add-panel-item').find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;
const _menuItem = (text: string) => $$('.menu-item').find((x) => x.textContent!.includes(text))!;
const _label = (text: string) => $$('.menu-section-label').find((x) => x.textContent === text);

test('machine and unresolved owners cannot enable app Plan mode from the add menu', async () => {
  for (const location of [
    { machine: 'box', pending: false },
    { machine: null, pending: true },
  ]) {
    fx.location = location;
    const m = await mountComposer({ threadId: 't1' });
    try {
      await click($('[aria-label="Add files and more"]'));
      assert.equal(item('Plan mode').getAttribute('aria-disabled'), 'true');
      await click(item('Plan mode'));
      assert.equal(last('session'), undefined);
      assert.ok(!$('.plan-chip'));
    } finally {
      await m.unmount();
    }
  }
});
