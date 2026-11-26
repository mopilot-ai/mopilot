// Every harness shares a compact composer footer so unequal split-pane widths keep the same empty composer height.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { appCss } from './support/app-css.ts';

const families = ['codex', 'claude', 'acp'];

function withFixtures(state: 'idle' | 'recovery' | 'floating' | 'floating-recovery', check: (root: HTMLElement) => void) {
  const style = document.createElement('style');
  style.textContent = appCss();
  document.head.append(style);
  const root = document.createElement('div');
  root.innerHTML = families
    .map(
      (kind) => `
    <div data-kind="${kind}" class="composer-wrap ${state.startsWith('floating') ? 'pane-float-composer' : ''}"><div class="composer"><div class="composer-footer">
      <div class="composer-left">
        <button class="composer-icon-btn">+</button>
        <span class="tooltip-anchor"><button class="perm-btn ${kind === 'acp' ? 'acp-mode-trigger' : ''}"><svg></svg><span>Full access</span></button></span>
      </div>
      <div class="composer-right">
        ${state.includes('recovery') ? '<span class="dictation-note"><span class="dictation-why">Recording retained. Dictation timed out</span><button>Retry</button><button>Discard</button></span>' : ''}
        <button class="model-btn ${kind === 'acp' ? 'acp-model-trigger' : ''}"><svg></svg><span class="model-name">A long model name</span><span class="route-mark">A very long external route label</span></button>
        <button class="composer-icon-btn mic">Mic</button><button class="send-btn">Send</button>
      </div>
    </div></div></div>`,
    )
    .join('');
  document.body.append(root);
  try {
    check(root);
  } finally {
    root.remove();
    style.remove();
  }
}

test('all harness footer groups keep a single row and shrink labels instead of adding height', () => {
  withFixtures('idle', (root) => {
    for (const kind of families) {
      for (const selector of ['.composer-footer', '.composer-right']) {
        const group = root.querySelector(`[data-kind="${kind}"] ${selector}`)!;
        assert.equal(getComputedStyle(group).flexWrap, 'nowrap', `${kind} ${selector}`);
        assert.equal(getComputedStyle(group).minWidth, '0', `${kind} ${selector} can shrink`);
      }
      // the left chips are the footer's own items, on its one row: the left group draws no box that could wrap or hold them
      assert.equal(getComputedStyle(root.querySelector(`[data-kind="${kind}"] .composer-left`)!).display, 'contents', kind);
      for (const selector of ['.composer-left > .tooltip-anchor', '.model-name']) {
        assert.equal(getComputedStyle(root.querySelector(`[data-kind="${kind}"] ${selector}`)!).minWidth, '0', `${kind} ${selector}`);
      }
      const route = getComputedStyle(root.querySelector(`[data-kind="${kind}"] .route-mark`)!);
      assert.equal(route.minWidth, '0', `${kind}: route labels can shrink`);
      assert.equal(route.overflow, 'hidden', `${kind}: route labels cannot cover adjacent actions`);
      assert.equal(route.textOverflow, 'ellipsis', `${kind}: truncated route names remain clear`);
      for (const selector of ['.composer-icon-btn', '.send-btn']) {
        for (const control of root.querySelectorAll(`[data-kind="${kind}"] ${selector}`)) {
          assert.equal(getComputedStyle(control).flexShrink, '0', `${kind} ${selector} retains its click target`);
        }
      }
    }
  });
});

test('dictation recovery feedback has a row above the footer, which keeps its single row of controls, on every harness', () => {
  withFixtures('recovery', (root) => {
    for (const kind of families) {
      const footer = root.querySelector(`[data-kind="${kind}"] .composer-footer`)!;
      const right = root.querySelector(`[data-kind="${kind}"] .composer-right`)!;
      const note = root.querySelector(`[data-kind="${kind}"] .dictation-note`)!;
      // the reported break: the footer and its right group wrapped, putting the model, the note and the actions on rows of their own
      assert.equal(getComputedStyle(footer).flexWrap, 'nowrap', `${kind}: the footer keeps one row`);
      assert.equal(getComputedStyle(right).flexWrap, 'nowrap', `${kind}: the model, mic and send stay together`);
      assert.equal(getComputedStyle(footer).position, 'relative', `${kind}: the note is placed against the footer`);
      assert.equal(getComputedStyle(note).position, 'absolute', `${kind}: the note leaves the controls' row`);
      assert.equal(getComputedStyle(note).bottom, 'calc(100% + 4px)', `${kind}: the note sits above the footer`);
      assert.equal(getComputedStyle(note).whiteSpace, 'nowrap', `${kind}: the note is one line`);
      assert.equal(getComputedStyle(footer).marginTop, 'calc(13.5px + 24px)', `${kind}: the footer makes room for the note row`);
      for (const button of note.querySelectorAll('button')) {
        assert.equal(getComputedStyle(button).flexShrink, '0', `${kind}: Retry and Discard are never cut`);
        assert.equal(getComputedStyle(button).marginLeft, '8px', `${kind}: Retry and Discard read as two actions`);
      }
      const why = getComputedStyle(note.querySelector('.dictation-why')!);
      assert.equal(why.overflow, 'hidden', `${kind}: a long reason is cut`);
      assert.equal(why.textOverflow, 'ellipsis', `${kind}: and says so`);
    }
  });
});

test('floating composers reserve spare width for their editor on every harness', () => {
  withFixtures('floating', (root) => {
    for (const kind of families) {
      const footer = root.querySelector(`[data-kind="${kind}"] .composer-footer`)!;
      const right = root.querySelector(`[data-kind="${kind}"] .composer-right`)!;
      assert.equal(getComputedStyle(footer).display, 'contents', `${kind}: floating controls stay beside the editor`);
      assert.equal(getComputedStyle(right).flexGrow, '0', `${kind}: floating editor owns spare width`);
      assert.equal(getComputedStyle(right).flexBasis, 'auto', `${kind}: floating controls keep intrinsic width`);
    }
  });
});

test('floating dictation feedback owns a row without consuming the editor beside it', () => {
  withFixtures('floating-recovery', (root) => {
    for (const kind of families) {
      assert.equal(getComputedStyle(root.querySelector(`[data-kind="${kind}"] .composer`)!).flexWrap, 'wrap');
      assert.equal(getComputedStyle(root.querySelector(`[data-kind="${kind}"] .composer-right`)!).flexBasis, '100%');
      const note = getComputedStyle(root.querySelector(`[data-kind="${kind}"] .dictation-note`)!);
      assert.equal(note.position, 'static', `${kind}: no footer row to sit above, so the note stays inside the composer`);
      assert.equal(note.flexBasis, '100%', `${kind}: the note owns its row`);
    }
  });
});

test('dictation feedback outside a composer retains the annotation and Ask MoMo row sizing', () => {
  withFixtures('recovery', (root) => {
    const note = document.createElement('span');
    note.className = 'dictation-note';
    note.textContent = 'Recording retained.';
    root.append(note);
    assert.notEqual(getComputedStyle(note).flexBasis, '100%');
    assert.equal(getComputedStyle(note).whiteSpace, 'nowrap');
  });
});
