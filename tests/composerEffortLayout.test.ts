// Selected reasoning labels follow the model button's available space, independent of composer width cutoffs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { appCss } from './support/app-css.ts';

async function withComposer(width: number, check: (window: Window) => void) {
  const window = new Window({ width, height: 800 });
  const style = window.document.createElement('style');
  // happy-dom does not lay out query containers. Evaluate the real container conditions at this fixture's width.
  style.textContent = appCss().replaceAll('@container composer', '@media');
  window.document.head.append(style);
  window.document.body.innerHTML = ['codex', 'claude']
    .map(
      (family) => `
      <div class="composer-wrap" data-family="${family}"><div class="composer"><div class="composer-footer">
        <div class="composer-left"><button class="composer-icon-btn">+</button></div>
        <div class="composer-right">
          <button class="model-btn"><svg class="harness-icon"></svg><span class="model-name">A long model name</span><span class="model-effort">Extra high</span><svg class="model-chevron"></svg></button>
          <button class="send-btn">Send</button>
        </div>
      </div></div></div>`,
    )
    .join('');
  try {
    check(window);
  } finally {
    await window.happyDOM.close();
  }
}

test('reasoning stays available on both sides of every old hiding breakpoint', async () => {
  for (const width of [640, 521, 520, 480, 421, 420, 360, 320, 640]) {
    await withComposer(width, (window) => {
      for (const family of ['codex', 'claude']) {
        const effort = window.document.querySelector(`[data-family="${family}"] .model-effort`)!;
        assert.notEqual(window.getComputedStyle(effort).display, 'none', `${family} reasoning at ${width}px`);
        assert.equal(effort.textContent, 'Extra high');
      }
    });
  }
});

test('crowded reasoning text can shrink with an ellipsis while model icons retain their click space', async () => {
  await withComposer(320, (window) => {
    for (const family of ['codex', 'claude']) {
      const model = window.document.querySelector(`[data-family="${family}"] .model-btn`)!;
      for (const selector of ['.model-name', '.model-effort']) {
        const text = window.getComputedStyle(model.querySelector(selector)!);
        assert.equal(text.minWidth, '0', `${family} ${selector} can shrink`);
        assert.equal(text.overflow, 'hidden', `${family} ${selector} stays inside the button`);
        assert.equal(text.textOverflow, 'ellipsis', `${family} ${selector} signals truncation`);
        assert.notEqual(text.flexShrink, '0', `${family} ${selector} yields only when space runs out`);
      }
      assert.equal(window.getComputedStyle(model.querySelector('.harness-icon')!).flexShrink, '0');
      assert.equal(window.getComputedStyle(window.document.querySelector(`[data-family="${family}"] .send-btn`)!).flexShrink, '0');
    }
  });
});
