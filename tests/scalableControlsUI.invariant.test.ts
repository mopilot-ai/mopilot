// Shared controls grow with their text; composer picker labels shrink to keep split-pane footers on one row.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { appCss } from './support/app-css.ts';

export const GUARDS = ['src/styles/'];

const style = document.createElement('style');
style.textContent = appCss();
before(() => document.head.append(style));
after(() => style.remove());

/** Happy DOM computes the real cascade but not line rectangles; the matching CI journey measures pixels. */
function surface(markup: string) {
  const host = document.createElement('section');
  host.innerHTML = markup;
  document.body.append(host);
  return host;
}

test('grant labels at both font sizes keep intrinsic height even when a long choice wraps', () => {
  for (const fontSize of [13, 24]) {
    for (const label of ['Allow once', 'Allow in this chat', 'Always allow', 'Allow this conversation', 'Allow and switch to Auto']) {
      const host = surface(
        `<div class="approval-foot"><div class="ap-split"><button class="ap-btn allow">${label}<kbd>⏎</kbd></button><button class="ap-btn allow chevron"><svg></svg></button></div></div>`,
      );
      host.style.setProperty('--fs-ui', `${fontSize}px`);
      try {
        const button = host.querySelector('.ap-btn.allow')!;
        assert.equal(getComputedStyle(button).fontSize, `${fontSize}px`, 'the test exercises the inherited font setting');
        intrinsicHeight(button, `${label} at ${fontSize}px`);
      } finally {
        host.remove();
      }
    }
  }
});

function intrinsicHeight(element: Element, label: string) {
  const css = getComputedStyle(element);
  assert.ok(css.height === '' || css.height === 'auto', `${label}: text owns height instead of a fixed pixel box (${css.height})`);
  assert.equal(css.minHeight, '28px', `${label}: default one-line control retains its 28px floor`);
}

for (const owner of ['', 'sage-approval', 'needs-you-answer']) {
  test(`approval actions retain intrinsic height in ${owner || 'native'} cards`, () => {
    const host = surface(
      `<div class="approval-card ${owner}"><div class="approval-foot"><button class="ap-btn deny">Deny<kbd>Esc</kbd></button><div class="ap-split"><button class="ap-btn allow">Allow once<kbd>⏎</kbd></button><button class="ap-btn allow chevron" aria-label="Approval options"><svg width="12" height="12"></svg></button></div></div></div>`,
    );
    try {
      assert.equal(getComputedStyle(host.querySelector('.approval-foot')!).flexWrap, 'wrap', 'choice groups move onto their own line');
      assert.equal(
        getComputedStyle(host.querySelector('.approval-foot')!).flexShrink,
        '0',
        'card height pressure cannot squash the actions',
      );
      assert.equal(getComputedStyle(host.querySelector('.ap-split')!).maxWidth, '100%', 'an oversized grant group is bounded by its card');
      for (const button of host.querySelectorAll('button')) intrinsicHeight(button, button.textContent ?? 'options');
      assert.equal(getComputedStyle(host.querySelector('kbd')!).flexShrink, '0', 'the keyboard hint keeps its own box');
    } finally {
      host.remove();
    }
  });
}

test('elicitation and ACP form action rows use the same intrinsic control sizing', () => {
  const host = surface(
    '<div class="approval-card"><div class="approval-footer"><button class="btn ghost sm">Decline</button><button class="btn primary sm">Submit</button></div></div>',
  );
  try {
    assert.equal(getComputedStyle(host.querySelector('.approval-footer')!).flexWrap, 'wrap');
    for (const button of host.querySelectorAll('button')) intrinsicHeight(button, button.textContent!);
  } finally {
    host.remove();
  }
});

test('question choices wrap as whole controls instead of compressing their answer labels', () => {
  const host = surface(
    '<div class="question-foot"><button class="ap-btn deny">Back</button><button class="ap-btn deny">Skip</button><button class="ap-btn allow solo">Submit answers</button></div>',
  );
  try {
    assert.equal(getComputedStyle(host.querySelector('.question-foot')!).flexWrap, 'wrap');
    for (const button of host.querySelectorAll('button')) intrinsicHeight(button, button.textContent!);
  } finally {
    host.remove();
  }
});

test('session options, Task and Context disclosures and model menus already use intrinsic height', () => {
  const host = surface(
    '<div class="suggest-row-actions"><button class="btn-pill soft">Options</button></div><label class="start-option">Model<select><option>A long external model name</option></select></label><div class="side-session-brief-label"><span>Task</span></div><div class="side-session-brief-label"><span>Context</span></div><summary class="summary-card-toggle">Context</summary><div class="summary-section-head"><span>Sources</span></div><button class="menu-item">A model menu choice</button>',
  );
  try {
    for (const element of host.querySelectorAll('button, select, .side-session-brief-label, summary, .summary-section-head')) {
      const css = getComputedStyle(element);
      assert.ok(css.height === '' || css.height === 'auto', `${element.className || element.tagName}: content owns its height`);
    }
    assert.equal(getComputedStyle(host.querySelector('.suggest-row-actions')!).flexWrap, 'wrap', 'Options and Start choices wrap together');
    assert.equal(
      getComputedStyle(host.querySelector('.start-option select')!).minWidth,
      '0',
      'external catalog labels do not widen the pane',
    );
  } finally {
    host.remove();
  }
});

test('permission, model and plan controls grow with the font while composer footer groups stay on one row', () => {
  const host = surface(
    '<div class="composer-footer"><div class="composer-left"><button class="perm-btn"><svg></svg><span>Ask for approval</span></button><button class="plan-chip">Plan</button><button class="goal-chip">Goal</button></div><div class="composer-right"><button class="model-btn"><svg></svg><span class="model-name">A long admitted harness model name</span><span class="model-effort">High</span></button><button class="send-btn">↑</button></div></div>',
  );
  try {
    for (const element of host.querySelectorAll('.composer-footer, .composer-left, .composer-right')) {
      assert.equal(getComputedStyle(element).flexWrap, 'nowrap', `${element.className}: pane width does not add a toolbar row`);
    }
    intrinsicHeight(host.querySelector('.composer-footer')!, 'composer footer');
    for (const button of host.querySelectorAll('.perm-btn, .model-btn, .plan-chip, .goal-chip')) {
      intrinsicHeight(button, button.className);
      assert.equal(getComputedStyle(button).whiteSpace, 'nowrap', `${button.className}: labels stay on one line`);
    }
    assert.equal(
      getComputedStyle(host.querySelector('.perm-btn > span')!).textOverflow,
      'ellipsis',
      'an externally named ACP mode still fits',
    );
    assert.equal(
      getComputedStyle(host.querySelector('.model-name')!).minWidth,
      '0',
      'an externally named model can shrink within the button',
    );
  } finally {
    host.remove();
  }
});
