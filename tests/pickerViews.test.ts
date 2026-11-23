// src/components/harnessPicker/pickerViews.tsx: the picker's harness, account and model rows as views fed by props, the same markup for This Mac and for a machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { $, $$, click, fire, mount } from './support/composer-kit.ts';

const { AccountChoiceRow, HarnessRowView, ModelRowsView } = await import('../src/components/harnessPicker/pickerViews.tsx');

function row(over: Record<string, unknown> = {}) {
  const log: unknown[][] = [];
  const props = {
    icon: h('i', { className: 'mark' }),
    title: 'Claude Code',
    disabled: false,
    current: false,
    hovered: false,
    onOpen: (el: HTMLElement, byKey: boolean) => log.push(['open', el.className.includes('hp-row'), byKey]),
    rowRef: (el: HTMLElement | null) => log.push(['ref', !!el]),
    ...over,
  };
  return { props, log };
}

test('a usable harness row: icon, title, usage line, chevron and check; it opens as the pointer moves over it, and by key', async () => {
  const { props, log } = row({
    usage: 'me@work.com · 16% left',
    usageKey: 'acct-1',
    current: true,
    trailing: h('span', { className: 'note' }, 'Update'),
  });
  const m = await mount(h(HarnessRowView, props));
  try {
    const el = $('.hp-row');
    // the title is the name alone (no stray space), for the accessible name and the row's matchers
    assert.equal($('.hp-title').textContent, 'Claude Code');
    assert.equal($('.menu-desc').textContent, 'me@work.com · 16% left');
    assert.equal($('.menu-desc').getAttribute('data-account'), 'acct-1');
    assert.ok($('.menu-chevron'));
    assert.ok($('.menu-check svg'));
    assert.ok($('.note'));
    assert.equal(el.getAttribute('aria-expanded'), 'false');
    await fire(el, new (window as any).MouseEvent('mousemove', { bubbles: true }));
    assert.deepEqual(log.at(-1), ['open', true, false]);
    // a click from the keyboard (detail 0) opens the models list with focus; a pointer click does not
    await fire(el, new (window as any).MouseEvent('click', { bubbles: true, detail: 0 }));
    assert.deepEqual(log.at(-1), ['open', true, true]);
    await fire(el, new (window as any).MouseEvent('click', { bubbles: true, detail: 1 }));
    assert.deepEqual(log.at(-1), ['open', true, false]);
  } finally {
    await m.unmount();
  }
});

test('a usage line that is something wrong takes the warning tone; one that is not keeps the plain line', async () => {
  const warn = await mount(h(HarnessRowView, row({ usage: 'me@work.com · Expired', usageTone: 'warn' }).props));
  try {
    assert.match($('.menu-desc').className, /acct-status warn/);
  } finally {
    await warn.unmount();
  }
  const plain = await mount(h(HarnessRowView, row({ usage: 'me@work.com' }).props));
  try {
    assert.equal($('.menu-desc').className, 'menu-desc');
  } finally {
    await plain.unmount();
  }
});

test('an open row does not reopen on every move; a harness that cannot be used shows only why', async () => {
  const open = row({ hovered: true });
  const a = await mount(h(HarnessRowView, open.props));
  try {
    assert.equal($('.hp-row').getAttribute('aria-expanded'), 'true');
    assert.match($('.hp-row').className, /open/);
    const before = open.log.length;
    await fire($('.hp-row'), new (window as any).MouseEvent('mousemove', { bubbles: true }));
    assert.equal(open.log.length, before);
  } finally {
    await a.unmount();
  }
  const off = row({
    disabled: true,
    badge: { text: 'Signed out', tone: 'warn' },
    extra: h('span', { className: 'menu-desc' }, 'Sign in on box'),
    usage: 'hidden',
  });
  const b = await mount(h(HarnessRowView, off.props));
  try {
    assert.equal($('.hp-row').getAttribute('aria-disabled'), 'true');
    assert.equal($('.hp-row').getAttribute('role'), 'group');
    assert.equal($('.hp-badge').textContent, 'Signed out');
    // a badge sits beside the name, never inside it
    assert.equal($('.hp-title').textContent, 'Claude Code');
    assert.equal($('.hp-title').querySelector('.hp-badge'), null);
    assert.match($('.hp-badge').className, /warn/);
    assert.equal($('.menu-chevron'), null);
    assert.doesNotMatch(document.body.textContent!, /hidden/);
    assert.match(document.body.textContent!, /Sign in on box/);
  } finally {
    await b.unmount();
  }
});

test('an account row picks when it can; one that only reports is not a control', async () => {
  const picked: string[] = [];
  const base = { rowKey: 'k', name: 'me@work.com', desc: 'Subscription · 60% left', tone: 'ok', checked: true };
  const a = await mount(h(AccountChoiceRow, { ...base, dim: true, onPick: () => picked.push('k') }));
  try {
    assert.equal($('.acct-email').textContent, 'me@work.com');
    assert.equal($('.acct-status').textContent, 'Subscription · 60% left');
    assert.match($('.acct-status').className, /ok/);
    assert.match($('[data-account=k]').className, /dim/);
    assert.equal($('[data-account=k]').getAttribute('aria-checked'), 'true');
    await click($('[data-account=k]'));
    assert.deepEqual(picked, ['k']);
  } finally {
    await a.unmount();
  }
  const b = await mount(h(AccountChoiceRow, { ...base, checked: false, disabled: true, onPick: () => picked.push('no') }));
  try {
    assert.equal($('[data-account=k]').getAttribute('aria-checked'), 'false');
    assert.doesNotMatch($('[data-account=k]').className, /dim/);
    assert.equal($('.menu-check svg'), null);
  } finally {
    await b.unmount();
  }
  const c = await mount(h(AccountChoiceRow, base));
  try {
    assert.equal($('[data-account=k]').getAttribute('role'), 'group');
    assert.ok($('.menu-check svg'));
  } finally {
    await c.unmount();
  }
});

const MODELS = [
  { id: 'opus', label: 'Opus 5.5', description: 'Best for complex work', note: 'Default' },
  { id: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'old', label: 'Opus 4.1', more: true },
];

test('the models: the main ones with their note, the current one checked, older versions folded under More versions', async () => {
  const picked: string[] = [];
  const m = await mount(h(ModelRowsView, { models: MODELS, current: 'opus', onPick: (c: { id: string }) => picked.push(c.id) }));
  try {
    const rows = $$('[role=menuitemradio]');
    assert.deepEqual(
      rows.map((r) => r.textContent),
      ['Opus 5.5Default', 'Sonnet 5.5'],
    );
    assert.equal(rows[0].getAttribute('aria-checked'), 'true');
    assert.match(rows[0].className, /has-desc/);
    assert.doesNotMatch(rows[1].className, /has-desc/);
    await click(rows[1]);
    assert.deepEqual(picked, ['sonnet']);
    const fold = $$('[aria-expanded]').find((r) => /More versions/.test(r.textContent ?? ''))!;
    assert.equal(fold.getAttribute('aria-expanded'), 'false');
    await click(fold);
    assert.deepEqual(
      $$('[role=menuitemradio]').map((r) => r.textContent),
      ['Opus 5.5Default', 'Sonnet 5.5', 'Opus 4.1'],
    );
    await click(fold);
    assert.equal($$('[role=menuitemradio]').length, 2);
  } finally {
    await m.unmount();
  }
  const only = await mount(h(ModelRowsView, { models: [MODELS[1]], current: null, onPick: () => undefined }));
  try {
    assert.equal($$('[aria-expanded]').length, 0, 'no older versions: no fold');
  } finally {
    await only.unmount();
  }
});

test('no models: a loading line, or a line that says so with the action that helps', async () => {
  const acted: string[] = [];
  const a = await mount(h(ModelRowsView, { models: [], current: null, loading: true, onPick: () => undefined }));
  try {
    assert.match($('.hp-models-loading').textContent!, /Loading models/);
  } finally {
    await a.unmount();
  }
  const b = await mount(
    h(ModelRowsView, {
      models: [],
      current: null,
      empty: { text: 'No models listed', action: 'Settings', onAction: () => acted.push('go') },
      onPick: () => undefined,
    }),
  );
  try {
    assert.equal($('.hp-models-empty .menu-desc').textContent, 'No models listed');
    await click($('.hp-mini'));
    assert.deepEqual(acted, ['go']);
  } finally {
    await b.unmount();
  }
  const c = await mount(h(ModelRowsView, { models: [], current: null, onPick: () => undefined }));
  try {
    assert.equal($('.hp-mini'), null);
  } finally {
    await c.unmount();
  }
});
