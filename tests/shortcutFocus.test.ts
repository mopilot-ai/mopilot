// Composer command ownership selects exactly one main or side surface and releases removed owners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window as domWindow } from './support/dom.ts';
const window = domWindow as unknown as Window & typeof globalThis;
import { dispatchComposerCommand, ownsComposerCommand, shortcutScope, textOwnsShortcut } from '../src/lib/shortcutFocus.ts';
test('text focus owns ordinary characters and editing but leaves Escape, function keys and app bindings available', () => {
  const input = document.createElement('input');
  assert.equal(shortcutScope(null), 'app');
  assert.equal(textOwnsShortcut(null, input), false);
  assert.equal(textOwnsShortcut('⌘A', null), false);
  for (const combo of ['A', '⇧8', '⌘A']) assert.equal(textOwnsShortcut(combo, input), true);
  for (const combo of ['Escape', '⇧Escape', 'F10', '⇧F10', '⌘1']) assert.equal(textOwnsShortcut(combo, input), false);
});
test('shortcuts and legacy slash commands target their own live composer', () => {
  const main = document.createElement('div');
  main.dataset.composerChat = 'a';
  main.dataset.composerMain = 'true';
  const side = document.createElement('div');
  side.dataset.composerChat = 'acp:opaque:"/side';
  side.dataset.composerMain = 'false';
  main.innerHTML = '<button>Main</button>';
  side.innerHTML = '<input />';
  document.body.append(main, side);
  const received: string[] = [];
  const listener = (e: Event) => {
    if (ownsComposerCommand(e, main.querySelector('button'))) received.push('main');
    if (ownsComposerCommand(e, side.querySelector('input'))) received.push('side');
  };
  window.addEventListener('open-model-picker', listener);
  window.addEventListener('open-project-menu', listener);
  try {
    side.querySelector('input')!.focus();
    dispatchComposerCommand('open-model-picker');
    assert.deepEqual(received, ['side']);
    main.querySelector('button')!.focus();
    dispatchComposerCommand('open-project-menu');
    assert.deepEqual(received, ['side', 'main']);
    (document.activeElement as HTMLElement).blur();
    dispatchComposerCommand('open-model-picker');
    assert.equal(received.at(-1), 'main');
    window.dispatchEvent(new Event('open-model-picker'));
    assert.equal(received.at(-1), 'main');
    assert.equal(ownsComposerCommand(new Event('open-model-picker'), null), false);
    main.remove();
    side.remove();
    dispatchComposerCommand('open-model-picker');
    assert.equal(received.length, 4);
  } finally {
    window.removeEventListener('open-model-picker', listener);
    window.removeEventListener('open-project-menu', listener);
    main.remove();
    side.remove();
  }
});
