// The composer footer of a chat on a machine keeps This Mac's permission and model labels: the host chip's long machine name gives way first, and a name cut to a sliver is hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import './support/dom.ts';
import { $, mount } from './support/composer-kit.ts';

import { mockSource } from './support/stubs.ts';
import type { HostMachine } from '../src/components/composer/HostChip.tsx';

mockSource('src/lib/flags.ts', {
  useFlag: () => false,
  isEnabled: () => false,
  harnessEnabled: () => true,
  useEnabledHarnesses: () => ['codex', 'claude'],
});
mockSource('src/lib/host.ts', { useHostAccess: () => true, hostAllowedNow: () => true, useHostAnswered: () => true });
mockSource('src/lib/hostMachines.ts', {
  useHostMachines: () => ({ machines: [], resolved: true }),
  readMachineAgents: async () => [],
  readMachineRow: async () => undefined,
});
const { createElement } = await import('react');
const { HostChip } = await import('../src/components/composer/HostChip.tsx');

const THIS_MAC: HostMachine = { id: 'local', name: 'This Mac', status: 'online', note: '' };

test("a chat on a machine keeps This Mac's labels: the footer cuts the machine's name first, down to its dot and laptop", async () => {
  const css = readFileSync(new URL('../src/styles/app/composer-controls.css', import.meta.url), 'utf8');
  // the reported layout: the footer's two groups shrank in proportion, so "LAPTOP-629FP…" took "Full acc…" and "Opus… H…" with it
  assert.match(
    css,
    /\n\.composer-left \{\s*display: contents;\s*\}/,
    "the left chips are the footer's own items, one shortage shared once",
  );
  const anchor = /\n\.composer-left > \.tooltip-anchor:has\(\.host-chip\) \{([^}]*)\}/.exec(css)?.[1] ?? '';
  // at 1000 the other labels still lost a fraction of a pixel to the proportion, which is enough for their ellipsis
  assert.match(anchor, /flex-shrink: 100000;/);
  assert.match(anchor, /min-width: 44px;/, 'the name goes, never the dot or the laptop (8 + 8 + 5 + 15 + 8)');
  assert.match(css, /\n\.host-chip > svg \{\s*flex-shrink: 0;\s*\}/);
  assert.match(css, /\n\.host-name\[data-sliver\] \{\s*visibility: hidden;\s*\}/, 'hidden, so its box and every other chip stay put');
  // the 28px squares the narrow and crowded footers fold the chip to are its floor there
  const narrow = css.slice(css.indexOf('@container composer (max-width: 520px)'), css.indexOf('@container composer (max-width: 640px)'));
  assert.match(narrow, /\.composer-left > \.tooltip-anchor:has\(\.host-chip\) \{\s*min-width: 28px;/);
  const crowded = css.slice(
    css.indexOf('@container composer (max-width: 640px)'),
    css.indexOf('@container composer (max-width: 420px) {\n  .composer-footer'),
  );
  assert.match(crowded, /\.composer-left:has\(\.goal-chip, \.plan-chip\) > \.tooltip-anchor:has\(\.host-chip\) \{\s*min-width: 28px;/);
  const tight = css.slice(css.indexOf('@container composer (max-width: 420px) {\n  .composer-footer'), css.indexOf('.host-dot {'));
  assert.match(tight, /\.composer-left > \* \{\s*flex: none;/, 'the left squares keep their size; the model button takes the rest');
  // the floating composer lays the same chips beside its editor, with no padding the footer's groups need
  const float = readFileSync(new URL('../src/styles/app/full-view.css', import.meta.url), 'utf8');
  assert.doesNotMatch(float, /\.composer-left \{/, 'a box that is not drawn takes no order');
  assert.match(float, /\.pane-float-composer \.composer-right \{[^}]*padding-left: 0;/);
});

test('a machine name cut to a sliver is hidden, never a stray letter or a bare "…"; one with room or that fits shows', async () => {
  const observers: { measure: () => void; observed: Element[]; disconnected: boolean }[] = [];
  const saved = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = class {
    entry: (typeof observers)[number];
    constructor(measure: () => void) {
      this.entry = { measure, observed: [], disconnected: false };
      observers.push(this.entry);
    }
    observe(el: Element) {
      this.entry.observed.push(el);
    }
    disconnect() {
      this.entry.disconnected = true;
    }
  };
  const style = document.createElement('style');
  // 12px type: below 30px a cut name is a sliver
  style.textContent = '.host-name { font-size: 12px; }';
  document.head.append(style);
  const name = () => $('.host-name');
  /** The name's box and its text's width, as the browser lays them out; then the observer reports the change. */
  const laidOut = async (box: number, text: number) => {
    Object.defineProperty(name(), 'clientWidth', { configurable: true, value: box });
    Object.defineProperty(name(), 'scrollWidth', { configurable: true, value: text });
    await act(async () => observers.at(-1)!.measure());
  };
  const machines = (box: string): HostMachine[] => [THIS_MAC, { id: 'box', name: box, status: 'online', note: '' }];
  const m = await mount(createElement(HostChip, { machines: machines('LAPTOP-629FPQ3K'), ownerId: 'box' }));
  try {
    assert.equal(name().textContent, 'LAPTOP-629FPQ3K');
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].observed, [name()], 'the name itself is watched');
    // mounted with no layout yet: nothing is cut
    assert.equal(name().hasAttribute('data-sliver'), false);
    await laidOut(6, 122);
    assert.equal(name().getAttribute('data-sliver'), '', 'six pixels of a cut name: hidden');
    await laidOut(40, 122);
    assert.equal(name().hasAttribute('data-sliver'), false, '"LAPT…" is a name: shown again as the pane widens');
    await laidOut(20, 20);
    assert.equal(name().hasAttribute('data-sliver'), false, 'a short name that fits its narrow box is whole, not a sliver');
    await laidOut(6, 122);
    assert.equal(name().getAttribute('data-sliver'), '');
    // a renamed machine is measured afresh, with no resize to report it: the short new name fits the same narrow box
    const span = name();
    Object.defineProperty(span, 'scrollWidth', { configurable: true, value: 6 });
    await m.render(createElement(HostChip, { machines: machines('mini'), ownerId: 'box' }));
    assert.equal(name(), span, 'the same element, so only a new measure could change what it says');
    assert.equal(name().textContent, 'mini');
    assert.equal(name().hasAttribute('data-sliver'), false, 'the new name is whole');
    assert.equal(observers.length, 2);
    assert.equal(observers[0].disconnected, true, 'the old watch ends');
    await laidOut(6, 50);
    assert.equal(name().getAttribute('data-sliver'), '', 'and the new one reports the next resize');
  } finally {
    await m.unmount();
    style.remove();
    (globalThis as any).ResizeObserver = saved;
  }
  assert.equal(observers[1].disconnected, true, 'unmounting ends the watch');
});
