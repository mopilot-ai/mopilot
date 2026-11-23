// The confirmation a copy button shows on itself (src/session/copyConfirm.ts): one check per click, only after
// the write lands, only for the latest click, never outliving the button; and the decay animation that fades
// it out lasts exactly as long as the state behind it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { autoMock, render, settle, moduleCalls, callsTo } from './support/thread-kit.ts';

/** Each copy's callbacks, kept so a test can settle them in any order. */
const writes: { text: string; done: () => void; failed: () => void }[] = [];
autoMock('src/session/clipboard.ts', 'clip', {
  copyText: (text: string, done: () => void, failed: () => void) => {
    moduleCalls.push(['clip:copyText', [text]]);
    writes.push({ text, done, failed });
  },
});
const { useCopyConfirm, COPY_CHECK_MS } = await import('../src/session/copyConfirm.ts');

beforeEach(() => {
  moduleCalls.length = 0;
  writes.length = 0;
});

/** A button pair over one hook, so a test can see which of two keys the check follows. */
function Probe({ a = 'alpha', b = 'beta' }: { a?: string; b?: string }): ReactNode {
  const { copied, copy } = useCopyConfirm();
  return h(
    'div',
    null,
    h('button', { className: 'a', onClick: () => copy(a, 'A') }, copied === 'A' ? 'checked' : 'idle'),
    h('button', { className: 'b', onClick: () => copy(b, 'B') }, copied === 'B' ? 'checked' : 'idle'),
  );
}

const shown = (r: { $: (s: string) => HTMLElement | null }) => [r.$('.a')!.textContent, r.$('.b')!.textContent];

test('a check appears only once the text is on the clipboard, and on the button that asked', async () => {
  const r = await render(h(Probe));
  await settle(() => r.$('.a')!.click());
  assert.deepEqual(callsTo('clip:copyText'), [['alpha']]);
  // the write has not landed yet: nothing is confirmed
  assert.deepEqual(shown(r), ['idle', 'idle']);
  await settle(() => writes[0].done());
  assert.deepEqual(shown(r), ['checked', 'idle']);
  await r.unmount();
});

test('a copy that fails shows no check and takes back the check from an earlier one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = await render(h(Probe));
  await settle(() => r.$('.a')!.click());
  await settle(() => writes[0].done());
  assert.deepEqual(shown(r), ['checked', 'idle']);
  await settle(() => r.$('.b')!.click());
  await settle(() => writes[1].failed());
  assert.deepEqual(shown(r), ['idle', 'idle']);
  // the first copy's hold timer was cleared with it, so its deadline passing confirms nothing
  await settle(() => t.mock.timers.tick(COPY_CHECK_MS * 2));
  assert.deepEqual(shown(r), ['idle', 'idle']);
  await r.unmount();
});

test('an older write settling after a newer click cannot check or clear the newer button', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = await render(h(Probe));
  await settle(() => r.$('.a')!.click());
  await settle(() => r.$('.b')!.click());
  await settle(() => writes[1].done());
  assert.deepEqual(shown(r), ['idle', 'checked']);
  // the older copy lands late, both ways round: neither moves the check back nor clears it
  await settle(() => writes[0].done());
  assert.deepEqual(shown(r), ['idle', 'checked']);
  await settle(() => writes[0].failed());
  assert.deepEqual(shown(r), ['idle', 'checked']);
  // and the newer check still ends on its own hold
  await settle(() => t.mock.timers.tick(COPY_CHECK_MS));
  assert.deepEqual(shown(r), ['idle', 'idle']);
  await r.unmount();
});

test('a newer click restarts the hold rather than inheriting the older deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = await render(h(Probe, { b: 'beta' }));
  await settle(() => r.$('.b')!.click());
  await settle(() => writes[0].done());
  const half = COPY_CHECK_MS / 2;
  await settle(() => t.mock.timers.tick(half));
  await settle(() => r.$('.b')!.click());
  await settle(() => writes[1].done());
  // the first click's deadline passes while the second's check is up, and does not take it away
  await settle(() => t.mock.timers.tick(half));
  assert.deepEqual(shown(r), ['idle', 'checked']);
  await settle(() => t.mock.timers.tick(half));
  assert.deepEqual(shown(r), ['idle', 'idle']);
  await r.unmount();
});

test('a write that lands after the button is gone neither confirms nor throws', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = await render(h(Probe));
  await settle(() => r.$('.a')!.click());
  await r.unmount();
  // the clipboard answers either way after the button went: both are no-ops, and no timer is left behind
  await settle(() => writes[0].done());
  await settle(() => writes[0].failed());
  await settle(() => t.mock.timers.tick(COPY_CHECK_MS * 2));
});

test('the hold timer does not outlive a button that unmounts while its check is up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = await render(h(Probe));
  await settle(() => r.$('.a')!.click());
  await settle(() => writes[0].done());
  assert.deepEqual(shown(r), ['checked', 'idle']);
  await r.unmount();
  await settle(() => t.mock.timers.tick(COPY_CHECK_MS * 2));
});

test('keys are compared whole, so one holding delimiters or quotes cannot stand in for another', async () => {
  // a key is a path or the copied text itself: it is never parsed or joined into a composite key
  const r = await render(h(Probe, { a: 'src/a:1.ts', b: 'src/a' }));
  const keyed = async (which: '.a' | '.b', key: string) => {
    await settle(() => r.$(which)!.click());
    await settle(() => writes.at(-1)!.done());
    assert.equal(writes.at(-1)!.text, key);
  };
  await keyed('.a', 'src/a:1.ts');
  assert.deepEqual(shown(r), ['checked', 'idle']);
  await keyed('.b', 'src/a');
  assert.deepEqual(shown(r), ['idle', 'checked']);
  await r.unmount();
});

test('a copy still confirms after the hook was retired and set up again', async () => {
  // the unmount cleanup retires the pending click by moving the counter, which a fresh mount starts over from
  const first = await render(h(Probe));
  await settle(() => first.$('.a')!.click());
  await first.unmount();
  const again = await render(h(Probe));
  await settle(() => again.$('.a')!.click());
  await settle(() => writes.at(-1)!.done());
  assert.deepEqual(shown(again), ['checked', 'idle']);
  await again.unmount();
});

test('the decay animation lasts exactly as long as the state that shows the check', () => {
  const css = postcss.parse(readFileSync(new URL('../src/styles/app/motion.css', import.meta.url), 'utf8'));
  /** What `prop` is set to for `.copy-check`, inside `media` or at the top level when it is null. */
  const declared = (prop: string, media: string | null) => {
    let value: string | null = null;
    css.walkRules((rule) => {
      const inMedia = rule.parent?.type === 'atrule' ? (rule.parent as postcss.AtRule).params : null;
      if (inMedia !== media || !rule.selectors.includes('.copy-check')) return;
      rule.walkDecls(prop, (decl) => {
        value = decl.value;
      });
    });
    return value as string | null;
  };

  const animation = declared('animation', null);
  assert.ok(animation, '.copy-check must carry the confirmation animation');
  const [name, duration] = animation.split(/\s+/);
  assert.equal(Number.parseInt(duration, 10), COPY_CHECK_MS, 'the animation would fade out before or after the check goes');
  assert.match(duration, /ms$/);

  // the check holds, then fades: a confirmation that snapped away is what this replaced
  const frames = new Map<string, string>();
  css.walkAtRules('keyframes', (at) => {
    if (at.params !== name) return;
    at.walkRules((step) => {
      frames.set(step.selector, step.nodes.map(String).join('; '));
    });
  });
  assert.deepEqual([...frames.keys()], ['0%,\n  75%', '100%']);
  assert.match(frames.get('0%,\n  75%')!, /opacity: 1; transform: scale\(1\)/);
  assert.match(frames.get('100%')!, /opacity: 0; transform: scale\(0\.92\)/);

  // and it is one of the animations a reader who asked for less motion does not get
  assert.equal(declared('animation', '(prefers-reduced-motion: reduce)'), 'none');
});
