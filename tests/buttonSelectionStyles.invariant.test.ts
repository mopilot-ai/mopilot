// Shared button styles prevent label selection inside copyable surfaces while preserving text fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { appCss } from './support/app-css.ts';

export const GUARDS = ['src/styles/'];

for (const surface of ['settings-page', 'thread-scroll']) {
  test(`${surface}: native and role buttons own their selection behavior inside selectable text`, async () => {
    const window = new Window();
    try {
      const { document } = window;
      const style = document.createElement('style');
      style.textContent = appCss();
      document.head.append(style);
      document.body.innerHTML = `<div class="app"><div class="${surface}">
        <p>Copyable description</p>
        <button class="btn-pill">Check for updates</button>
        <button class="select-btn"><span class="select-label">Dogfood</span></button>
        <button disabled>Unavailable action</button>
        <button class="question-option"><span class="question-option-copy"><span class="question-option-label">Blue</span></span></button>
        <div role="button" tabindex="0"><span>Open chat</span><input class="text-input" value="Rename chat"></div>
        <textarea class="text-area">Editable text</textarea>
      </div></div>`;
      const container = document.querySelector(`.${surface}`)!;
      assert.equal(window.getComputedStyle(container).userSelect, 'text', 'the surrounding content remains copyable');
      for (const button of container.querySelectorAll('button, [role="button"]')) {
        assert.equal(window.getComputedStyle(button).userSelect, 'none', `${button.textContent}: button labels cannot inherit selection`);
      }
      const optionCopy = container.querySelector('.question-option-copy')!;
      assert.ok(
        !['text', 'all'].includes(window.getComputedStyle(optionCopy).userSelect),
        'a nested question label cannot opt back into text selection',
      );
      for (const field of container.querySelectorAll('input, textarea')) {
        assert.equal(window.getComputedStyle(field).userSelect, 'text', 'editing and selecting user input remains available');
      }
    } finally {
      await window.happyDOM.close();
    }
  });
}
