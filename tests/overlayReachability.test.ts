// Fixed overlays keep their first and last controls reachable through the full app stylesheet cascade.
import { after, before, test } from 'node:test';
import { appCss } from './support/app-css.ts';
import { assert, h, act, task, render, click, byText } from './support/scheduled-page.ts';

const { ScheduleDialog } = await import('../src/components/pages/scheduled/ScheduleDialog.tsx');
const { Modal } = await import('../src/components/ui/Modal.tsx');
const style = document.createElement('style');
style.textContent = appCss();
before(() => document.head.append(style));
after(() => style.remove());

/**
 * Happy DOM computes the cascade but does not lay out pixels. These checks enforce the CSS contract
 * that lets Chromium scroll oversized content, rather than pretending getBoundingClientRect is a
 * viewport test. Browser hit-testing at a small native window remains part of release verification.
 */
function viewportScroller(element: Element) {
  const css = getComputedStyle(element);
  assert.equal(css.position, 'fixed');
  assert.equal(css.inset, '0');
  assert.equal(css.overflowY, 'auto', 'the fixed backdrop must own vertical scrolling');
  assert.equal(css.paddingBottom, '24px', 'the last action has space below it when scrolled into view');
  return css;
}

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`the expanded ${harness} Schedule form keeps its header and footer in one top-aligned scroller`, async (t) => {
    const saved: any[] = [];
    let cancelled = 0;
    const v = await render(
      h(ScheduleDialog, {
        initial: task('', {
          harness,
          prompt: 'Check this project',
          rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
        }),
        onSave: (a: any) => saved.push(a),
        onCancel: () => cancelled++,
      }),
    );
    t.after(() => v.unmount());
    await click(v.host.querySelector('[aria-label="Advanced"]'));
    const backdrop = v.host.querySelector('.sched-dialog-backdrop')!;
    const dialog = v.host.querySelector('.sched-dialog')!;
    const head = dialog.querySelector('.sched-dialog-head')!;
    const foot = dialog.querySelector('.sched-dialog-foot')!;
    const css = viewportScroller(backdrop);
    assert.equal(css.alignItems, 'flex-start', 'oversized forms cannot center above the scroll origin');
    assert.equal(css.justifyContent, 'center', 'horizontal placement is unchanged');
    assert.equal(css.paddingTop, '125px', 'normal desktop placement is unchanged');
    assert.equal(backdrop.contains(head), true);
    assert.equal(backdrop.contains(foot), true);
    assert.ok(dialog.querySelectorAll('.sched-adv .sched-card').length >= 6);
    const create = byText(foot, 'Create');
    await act(async () => create.focus());
    assert.equal(document.activeElement === create, true, 'the footer remains keyboard-focusable');
    await click(create);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].harness, harness);
    await click(v.host.querySelector('[aria-label="Advanced"]'));
    assert.equal(dialog.querySelector('.sched-adv'), null);
    viewportScroller(backdrop);
    await click(byText(foot, 'Cancel'));
    assert.equal(cancelled, 1);
  });
}

test('the palette can scroll past its top offset while keeping its bounded inner result list', () => {
  const host = document.createElement('div');
  host.innerHTML =
    '<div class="palette-backdrop"><div class="palette"><input class="palette-input"><div class="palette-list"><button class="palette-item">Last result</button></div></div></div>';
  document.body.append(host);
  try {
    const backdrop = host.querySelector('.palette-backdrop')!;
    const palette = host.querySelector('.palette')!;
    const css = viewportScroller(backdrop);
    assert.equal(css.paddingTop, '250px');
    assert.equal(css.justifyContent, 'center');
    assert.equal(getComputedStyle(palette).alignSelf, 'flex-start');
    assert.equal(getComputedStyle(palette).maxHeight, '520px');
    assert.equal(getComputedStyle(host.querySelector('.palette-list')!).overflowY, 'auto');
    assert.equal(backdrop.contains(host.querySelector('.palette-item')), true);
  } finally {
    host.remove();
  }
});

test('shared dialogs center when they fit and use safe alignment when content overflows', async (t) => {
  let closed = 0;
  const v = await render(
    h(Modal, {
      title: 'Long form',
      onClose: () => closed++,
      children: [
        h('div', { key: 'content', style: { height: '1200px' } }, 'Tall content'),
        h('button', { key: 'action', onClick: () => closed++ }, 'Last action'),
      ],
    }),
  );
  t.after(() => v.unmount());
  const backdrop = v.host.querySelector('.sketch-backdrop')!;
  const css = viewportScroller(backdrop);
  assert.equal(css.display, 'grid');
  assert.equal(css.placeItems, 'center', 'fitting dialogs retain their normal centering');
  assert.equal(css.alignItems, 'safe center', 'overflow falls back to start alignment, never above the scroll origin');
  assert.equal(css.paddingTop, '24px');
  assert.equal(css.paddingLeft, '24px');
  assert.equal(css.paddingRight, '24px');
  assert.equal(backdrop.contains(v.host.querySelector('.dialog-head')), true);
  assert.equal(backdrop.contains(byText(v.host, 'Last action')), true);
  await click(byText(v.host, 'Last action'));
  await click(v.host.querySelector('[aria-label="Close"]'));
  assert.equal(closed, 2);
});

test('the separate modal keeps its viewport height bound and scrolls only its body', () => {
  const host = document.createElement('div');
  host.innerHTML =
    '<div class="modal-backdrop"><div class="modal"><div class="modal-head"></div><div class="modal-body"></div><div class="modal-foot"></div></div></div>';
  document.body.append(host);
  try {
    const modal = host.querySelector('.modal')!;
    const body = host.querySelector('.modal-body')!;
    assert.equal(getComputedStyle(modal).maxHeight, `${window.innerHeight * 0.86}px`);
    assert.equal(getComputedStyle(body).overflowY, 'auto');
    assert.equal(body.contains(host.querySelector('.modal-head')), false);
    assert.equal(body.contains(host.querySelector('.modal-foot')), false);
  } finally {
    host.remove();
  }
});
