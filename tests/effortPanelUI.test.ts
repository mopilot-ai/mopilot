// src/components/harnessPicker/EffortPanel.tsx: the model picker's effort panel, shared by the composer's model picker and
// MoMo's brain chip: its More row, the head (effort name, model line back to the list, reset), the slider by pointer and
// arrow keys within the model's levels, the harness's own level names, and what it says without levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';

const { EffortPanel, MoreRow } = await import('../src/components/harnessPicker/EffortPanel.tsx');

function panel(over: Record<string, unknown> = {}) {
  const log: unknown[][] = [];
  const props = {
    open: true,
    efforts: ['low', 'medium', 'high'],
    effort: 'medium',
    noEffort: 'This model has no effort levels',
    onEffort: (e: string) => log.push(['effort', e]),
    onReset: () => log.push(['reset']),
    onBack: () => log.push(['back']),
    model: h('span', null, 'Claude Code · Opus'),
    ...over,
  };
  return { props, log };
}

const key = async (el: Element, k: string) =>
  act(async () => {
    el.dispatchEvent(new (globalThis as any).window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
const pointer = async (el: Element, type: string, clientX: number, buttons = 1) =>
  act(async () => {
    const e = new (globalThis as any).window.MouseEvent(type, { bubbles: true, clientX, buttons });
    Object.assign(e, { pointerId: 1 });
    el.dispatchEvent(e);
  });

test('the head names the effort and the model; back and reset; arrows move within the levels', async () => {
  const { props, log } = panel();
  const r = await render(h(EffortPanel, props, h('p', null, 'below')));
  await flush();
  const pop = r.host.querySelector('.effort-pop')!;
  assert.equal(r.host.querySelector('.effort-name')!.textContent, 'Medium');
  assert.match(r.host.querySelector('.effort-model')!.textContent!, /Claude Code · Opus/);
  assert.equal(r.host.querySelector('[role=slider]')!.getAttribute('aria-valuenow'), '1');
  assert.equal(r.host.querySelectorAll('.effort-dot').length, 3);
  assert.ok(r.host.textContent!.includes('below'));
  await click(r.host.querySelector('button[aria-label="Select harness and model"]')!);
  await click(r.host.querySelector('button[aria-label="Reset to default"]')!);
  await key(pop, 'ArrowRight');
  await key(pop, 'ArrowLeft');
  await key(pop, 'Enter');
  assert.deepEqual(log, [['back'], ['reset'], ['effort', 'high'], ['effort', 'low']]);
  await r.unmount();
  // at either end an arrow changes nothing
  const top = panel({ effort: 'high' });
  const t = await render(h(EffortPanel, top.props));
  await key(t.host.querySelector('.effort-pop')!, 'ArrowRight');
  assert.deepEqual(top.log, []);
  await t.unmount();
});

test('the slider follows the pointer while a button is held', async () => {
  const { props, log } = panel();
  const r = await render(h(EffortPanel, props));
  const track = r.host.querySelector('[role=slider]') as HTMLElement;
  // a 228px track: 14px insets, 100px per level
  track.getBoundingClientRect = () => ({ left: 0, width: 228, top: 0, height: 10, right: 228, bottom: 10, x: 0, y: 0, toJSON: () => null });
  // on the level it has: nothing to change
  await pointer(track, 'pointerdown', 114);
  await pointer(track, 'pointerdown', 214);
  await pointer(track, 'pointermove', 14);
  await pointer(track, 'pointermove', 114, 0);
  assert.deepEqual(log, [
    ['effort', 'high'],
    ['effort', 'low'],
  ]);
  await r.unmount();
});

test('a caller that says so shows a model with levels and none chosen as unset: its word, no knob on any level', async () => {
  const { props } = panel({ effort: null, unsetLabel: 'Default' });
  const r = await render(h(EffortPanel, props));
  assert.equal(r.host.querySelector('.effort-name')!.textContent, 'Default');
  const slider = r.host.querySelector('[role=slider]')!;
  assert.equal(slider.getAttribute('aria-valuenow'), null);
  assert.equal(slider.getAttribute('aria-valuetext'), 'Default');
  assert.equal(r.host.querySelector('.effort-knob'), null);
  assert.equal(r.host.querySelector('.effort-fill'), null);
  assert.equal(r.host.querySelectorAll('.effort-dot').length, 3);
  await r.unmount();
  // a level chosen is shown as always; no levels says Default whatever the caller says
  const chosen = await render(h(EffortPanel, panel({ effort: 'high', unsetLabel: 'Default' }).props));
  assert.equal(chosen.host.querySelector('.effort-name')!.textContent, 'High');
  assert.equal(chosen.host.querySelector('[role=slider]')!.getAttribute('aria-valuetext'), null);
  assert.ok(chosen.host.querySelector('.effort-knob'));
  await chosen.unmount();
  const flat = await render(h(EffortPanel, panel({ efforts: [], effort: null, unsetLabel: 'Unset' }).props));
  assert.equal(flat.host.querySelector('.effort-name')!.textContent, 'Default');
  await flat.unmount();
});

test('a harness’s own level names; no effort picked; no reset; no levels', async () => {
  const named = panel({ efforts: ['quick', 'deep'], effort: 'deep', labelOf: (e: string) => `Level ${e}`, onReset: undefined });
  const r = await render(h(EffortPanel, named.props));
  assert.equal(r.host.querySelector('.effort-name')!.textContent, 'Level deep');
  assert.equal(r.host.querySelector('button[aria-label="Reset to default"]'), null);
  // the fast slot is empty unless one is given
  assert.equal(r.host.querySelectorAll('.effort-icon-btn[aria-hidden]').length, 2);
  await r.unmount();
  const none = panel({ effort: null, lead: h('button', { 'aria-label': 'Toggle fast mode' }) });
  const n = await render(h(EffortPanel, none.props));
  assert.equal(n.host.querySelector('.effort-name')!.textContent, '');
  assert.equal(n.host.querySelector('[role=slider]')!.getAttribute('aria-valuenow'), '0');
  assert.equal(n.host.querySelector('[role=slider]')!.getAttribute('aria-valuetext'), null);
  assert.ok(n.host.querySelector('button[aria-label="Toggle fast mode"]'));
  await n.unmount();
  const flat = panel({ efforts: [], effort: null });
  const f = await render(h(EffortPanel, flat.props));
  assert.equal(f.host.querySelector('.effort-name')!.textContent, 'Default');
  assert.equal(f.host.querySelector('[role=slider]'), null);
  assert.equal(f.host.querySelector('.hp-no-effort')!.textContent, 'This model has no effort levels');
  await f.unmount();
});

test('the More row names what is behind it', async () => {
  let opened = 0;
  const r = await render(h(MoreRow, { desc: 'High · Fast', onClick: () => opened++ }));
  const row = r.host.querySelector('.hp-more-row')!;
  assert.match(row.textContent!, /More/);
  assert.match(row.textContent!, /High · Fast/);
  await click(row as HTMLElement);
  assert.equal(opened, 1);
  await r.unmount();
});

test('a title row that opens a list is its menu button: it says whether the list is open and hands its element over', async () => {
  // only going back (MoMo): a plain button
  const plain = await render(h(EffortPanel, panel().props));
  const back = plain.host.querySelector('.effort-title')!;
  assert.equal(back.getAttribute('aria-haspopup'), null);
  assert.equal(back.getAttribute('aria-expanded'), null);
  assert.equal(back.className, 'effort-title');
  await plain.unmount();
  // opening the harness list (the composer's picker)
  let el: HTMLButtonElement | null = null;
  const closed = panel({ titleRef: (x: HTMLButtonElement | null) => (el = x), titleExpanded: false });
  const r = await render(h(EffortPanel, closed.props));
  const title = r.host.querySelector('.effort-title')!;
  assert.equal(el, title);
  assert.equal(title.getAttribute('aria-haspopup'), 'menu');
  assert.equal(title.getAttribute('aria-expanded'), 'false');
  await r.unmount();
  const open = await render(h(EffortPanel, panel({ titleExpanded: true }).props));
  const t = open.host.querySelector('.effort-title')!;
  assert.equal(t.getAttribute('aria-expanded'), 'true');
  assert.equal(t.className, 'effort-title open');
  await open.unmount();
});
