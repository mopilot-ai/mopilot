// Transcript spacing keeps related work together and reserves clear space above the floating composer pills.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window, type Element } from 'happy-dom';

const window = new Window();
after(() => window.happyDOM.abort());
window.document.head.innerHTML = `<style>${[
  '../src/styles/app/thread.css',
  '../src/styles/app/thread-messages.css',
  '../src/styles/app/edited-files.css',
  '../src/components/thread/prInbox.module.css',
]
  .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
  .join('\n')}</style>`;
const px = (value: string) => Number.parseFloat(value) || 0;
const style = (el: Element) => window.getComputedStyle(el);

test('goal and inbox pills leave a 24px gap after the last transcript row, scoped to their own pane', () => {
  for (const pill of ['goal-pill', 'pill']) {
    window.document.body.innerHTML = `
      <div class="thread-scroll-wrap" id="with-pill">
        <div class="thread-bottom-spacer"></div>
        <div class="composer-pills"><button class="${pill}">Status</button></div>
      </div>
      <div class="thread-scroll-wrap" id="without-pill"><div class="thread-bottom-spacer"></div></div>`;
    const root = window.document.querySelector('#with-pill')!;
    const row = style(root.querySelector('.composer-pills')!);
    const button = style(root.querySelector('button')!);
    const reserve = px(style(root.querySelector('.thread-bottom-spacer')!).height);
    assert.ok(reserve - px(row.bottom) - px(button.height) >= 24, `${pill}: only ${reserve - px(row.bottom) - px(button.height)}px clear`);
    assert.equal(style(window.document.querySelector('#without-pill .thread-bottom-spacer')!).height, '40px');
    root.querySelector('.composer-pills')!.remove();
    assert.equal(style(root.querySelector('.thread-bottom-spacer')!).height, '40px', 'removing the last pill releases its space');
  }
});

test('commentary stays closer to its preceding summary than the next update, live and restored', () => {
  for (const live of [false, true]) {
    const text = '<div class="commentary">The focused tests pass.</div>';
    window.document.body.innerHTML = `<div class="work">
      <div class="step-group">Ran 3 commands</div>
      ${live ? `<div class="item-enter">${text}</div>` : text}
      <div class="step-group">Read 2 files</div>
      ${live ? `<div class="item-enter">${text}</div>` : text}
    </div>`;
    const work = window.document.querySelector('.work')!;
    const gap = px(style(work).gap);
    const commentary = work.children[1];
    const before = gap + px(style(commentary).marginTop);
    const after = gap + px(style(commentary).marginBottom);
    assert.equal(before, 12, 'related summaries and commentary keep a consistent gap');
    assert.equal(after, 20, 'separate updates have a clear break');
    assert.equal(px(style(work.lastElementChild!).marginBottom), 0, 'the final update adds no trailing margin');
  }
});
