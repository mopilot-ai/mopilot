// The shared turn box's card and task rows through the full app CSS cascade in comfortable density:
// full column width, 16px padding, 12px corners, an inset 1px ring, the
// step text 4px past its icon, and the running status line one control (28px) tall above it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { appCss } from './support/app-css.ts';

const STEPS = `<ol class="todo-list">
  <li class="todo-step completed"><span class="todo-check"></span><span class="todo-text">Done</span></li>
  <li class="todo-step inProgress"><span class="todo-check"></span><span class="todo-text">Running</span></li>
  <li class="todo-step pending"><span class="todo-check"></span><span class="todo-text">Waiting</span></li>
  <li class="todo-step in_progress"><span class="todo-check"></span><span class="todo-text">Unknown status</span></li>
</ol>`;
/** Elements inked with a token, so the test compares against what each token resolves to rather than its value. */
const INKS = ['text', 'text-2', 'text-3', 'text-4'].map((t) => `<span id="ink-${t}" style="color: var(--${t})"></span>`).join('');

function fixture() {
  const window = new Window();
  const document = window.document;
  const style = document.createElement('style');
  // the tokens too, so the inks resolve to the colors they draw
  style.textContent = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8') + appCss();
  document.head.append(style);
  document.body.innerHTML = `<div class="thread-column">
    <div class="turn-slot"><div class="turn last"><div class="claude-activity" id="row">Ran a command</div>
      <section class="todo-card" id="inline">${STEPS}</section></div></div>
    <div class="turn-status-slot"><div class="placeholder-reveal"><div class="claude-activity" id="status">Running</div></div></div>
    <div class="turn-box with-tasks"><section class="todo-card turn-tasks" id="box"><p class="turn-tasks-more">1 more to go</p>${STEPS}</section></div>
    <div class="turn-box"><section class="wrap-up-box" id="wrap">Recap</section></div>
  </div>${INKS}`;
  const style$ = (selector: string) => window.getComputedStyle(document.querySelector(selector)!);
  return { window, style$ };
}

test('the task card and the wrap-up are MoPilot turn box cards across the full column', async () => {
  const f = fixture();
  try {
    for (const card of ['#box', '#wrap']) {
      const s = f.style$(card);
      assert.equal(s.maxWidth, 'none', `${card} spans the column`);
      assert.equal(s.padding, '16px', `${card} padding`);
      assert.equal(s.borderRadius, '12px', `${card} corners`);
      assert.match(s.borderTopWidth, /^(0px|0)$/, `${card} draws its edge as a ring, not a border`);
      assert.equal(s.boxShadow, 'inset 0 0 0 1px rgba(238, 241, 246, 0.1)', `${card} ring`);
    }
    assert.equal(f.style$('.turn-box.with-tasks').marginTop, '15px', 'the turn gap above the task list');
    assert.equal(f.style$('.turn-box:not(.with-tasks)').marginBlock, '4px 12px', 'a recap alone follows the turn margin');
  } finally {
    await f.window.happyDOM.abort();
  }
});

test("the box's steps sit 4px past their icon, 8px apart, while an inline task card keeps its own spacing", async () => {
  const f = fixture();
  try {
    assert.equal(f.style$('#box .todo-step').gap, '4px');
    assert.equal(f.style$('#box .todo-step').padding, '0px');
    assert.equal(f.style$('#box .todo-list').gap, '8px');
    assert.equal(f.style$('#box').gap, '4px', 'its notes sit 4px from the list');
    assert.equal(f.style$('#box .turn-tasks-more').paddingLeft, '24px');
    assert.equal(f.style$('#inline .todo-step').gap, '10px', 'the inline card is unchanged');
    assert.equal(f.style$('#inline .todo-step').padding, '4px 0px');
  } finally {
    await f.window.happyDOM.abort();
  }
});

test("the box inks finished steps secondary, open steps primary and a waiting step's marker muted", async () => {
  const f = fixture();
  try {
    const ink = (selector: string) => f.style$(selector).color;
    const token = (t: string) => ink(`#ink-${t}`);
    assert.equal(ink('#box .todo-step.inProgress'), token('text'), 'a running step is primary');
    assert.equal(ink('#box .todo-step.pending'), token('text'), 'a waiting step is primary');
    assert.equal(ink('#box .todo-step.completed .todo-text'), token('text-2'), 'a finished step is secondary');
    assert.equal(ink('#box .todo-step.pending .todo-check'), token('text-3'), "a waiting step's marker is muted");
    assert.equal(ink('#box .todo-step.in_progress .todo-check'), token('text-3'), 'so is the marker of a status outside the union');
    assert.equal(ink('#box .todo-step.inProgress .todo-check'), token('text-2'), 'the running marker keeps its ink');
    assert.equal(ink('#inline .todo-step.pending .todo-check'), token('text-4'), 'the inline card is unchanged');
  } finally {
    await f.window.happyDOM.abort();
  }
});

test('the status line is one control tall; a running row in the transcript keeps its own height', async () => {
  const f = fixture();
  try {
    assert.equal(f.style$('#status').minHeight, '28px');
    assert.equal(f.style$('#row').minHeight, '21px');
  } finally {
    await f.window.happyDOM.abort();
  }
});
