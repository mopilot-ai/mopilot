// Task checklist spacing through the full app CSS cascade, including src/styles/app/peer-messages.css.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { appCss } from './support/app-css.ts';

function fixture(box: string, reply = '') {
  const window = new Window();
  const document = window.document;
  const style = document.createElement('style');
  style.textContent = appCss();
  document.head.append(style);
  document.body.innerHTML = `<div class="thread-column">
    <div class="turn-slot"><div class="turn"><div class="collapse open"><div class="collapse-inner"><div class="work">Earlier command</div></div></div></div></div>
    <div class="turn-slot"><div class="turn last"><div class="collapse open"><div class="collapse-inner"><div class="work"><button class="step-row summary">Ran a command</button></div></div></div>${reply}</div></div>
    ${box}<div class="turn-status-slot"></div>
  </div>`;
  const margin = (selector: string) => window.getComputedStyle(document.querySelector(selector)!).marginBottom;
  return { window, margin };
}

test('the latest command meets its checklist without stacking work and turn margins', async () => {
  const f = fixture('<div class="turn-box with-tasks"><section class="turn-tasks">Task checklist</section></div>');
  try {
    assert.equal(f.margin('.turn.last'), '0px');
    assert.equal(f.margin('.turn.last .work'), '0px');
    assert.equal(f.margin('.turn:not(.last)'), '10px', 'earlier messages keep their separation');
    assert.equal(f.margin('.turn:not(.last) .work'), '16px');
  } finally {
    await f.window.happyDOM.abort();
  }
});

test('a final reply keeps its separation from the work above it', async () => {
  const f = fixture(
    '<div class="turn-box with-tasks"><section class="turn-tasks">Task checklist</section></div>',
    '<div class="assistant-message">Finished</div>',
  );
  try {
    assert.equal(f.margin('.turn.last .work'), '16px');
  } finally {
    await f.window.happyDOM.abort();
  }
});

for (const box of ['', '<div class="turn-box"><section class="wrap-up-box">Recap</section></div>']) {
  test(`normal turn spacing remains with ${box ? 'a recap' : 'no checklist'}`, async () => {
    const f = fixture(box);
    try {
      assert.equal(f.margin('.turn.last'), '10px');
      assert.equal(f.margin('.turn.last .work'), '16px');
    } finally {
      await f.window.happyDOM.abort();
    }
  });
}

/** The latest turn with the running turn's status row directly under it (no task list), the work empty or holding a step. */
function liveFixture(work: string) {
  const window = new Window();
  const document = window.document;
  const style = document.createElement('style');
  style.textContent = appCss();
  document.head.append(style);
  document.body.innerHTML = `<div class="thread-column">
    <div class="turn-slot"><div class="turn"><div class="user-message">earlier</div></div></div>
    <div class="turn-slot"><div class="turn last"><div class="user-message">asked</div><div class="collapse open"><div class="collapse-inner"><div class="work">${work}</div></div></div></div></div>
    <div class="turn-status-slot"><div class="claude-activity">Running npm test</div></div>
  </div>`;
  const style$ = (selector: string) => window.getComputedStyle(document.querySelector(selector)!);
  return { window, style$ };
}

test('the live status row sits 19.75px under the last step: the turn and its work give up their margins to it (#5342)', async () => {
  const f = liveFixture('<button class="step-row summary">Checked the open tabs</button>');
  try {
    assert.equal(f.style$('.turn.last').marginBottom, '0px');
    assert.equal(f.style$('.turn.last .work').marginBottom, '0px');
    assert.equal(f.style$('.turn-status-slot').marginTop, '19.75px');
    assert.equal(f.style$('.turn:not(.last)').marginBottom, '10px', 'earlier turns keep their separation');
    assert.equal(f.style$('.turn-status-slot .claude-activity').minHeight, '28px');
  } finally {
    await f.window.happyDOM.abort();
  }
});

test('with nothing but the message above it the live row is 15.75px under the bubble, not under the 40px kept for a reply (#5342)', () => {
  // happy-dom cannot evaluate a relative :has() with several combinators, so the rules are read as written; the real app's
  // numbers are tests/e2e/status-row-gap.spec.ts's
  const css = appCss();
  const work = ['.work:empty', '.work > .item-enter:only-child:empty'];
  for (const w of work)
    for (const message of [
      `.user-message:has(+ .collapse:last-child > .collapse-inner > ${w})`,
      `.item-enter:has(+ .collapse:last-child > .collapse-inner > ${w}) > .user-message`,
    ])
      assert.ok(css.includes(message), `a rule for ${message}`);
  assert.match(css, /\.user-message\s*\{\s*margin-bottom:\s*-12px/);
});

test('no status row, no change: a finished turn keeps its own margins (#5342)', async () => {
  const f = liveFixture('<button class="step-row summary">Ran a command</button>');
  try {
    f.window.document.querySelector('.turn-status-slot')!.innerHTML = '';
    assert.equal(f.style$('.turn.last').marginBottom, '10px');
    assert.equal(f.style$('.turn.last .work').marginBottom, '16px');
    assert.notEqual(f.style$('.turn-status-slot').marginTop, '19.75px', 'the slot is out of the way when empty');
  } finally {
    await f.window.happyDOM.abort();
  }
});
