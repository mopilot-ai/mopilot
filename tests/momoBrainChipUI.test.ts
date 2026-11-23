// src/components/momo/BrainChip.tsx (#2139): the chip names MoMo's brain compactly (harness · model, the account in its menu; or a basic harness by
// its name), and its menu changes it from the model picker's own rows, telling the user how the change reaches the chat; its More row
// opens the model picker's effort panel for the effort MoMo replies at.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, byText, maybeText, flush, popoverExports } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const toasts: any[] = [];
const sets: any[] = [];
let brain: any = { harness: 'claude', account: 'du@work', model: 'opus', modelLabel: null };
let reply: (next: any) => Promise<any> = async (next) => ({
  brain: { modelLabel: null, ...next },
  chatId: 'c',
  applied: 'now',
  warning: null,
});
let readFails = false;
let openFails = false;
let mainId = 'momo-chat';
const opened: string[] = [];
const listeners = new Set<(b: any) => void>();
let noModels = false;
/** what useBrainEffort answers (its own tests: momoBrainEffortUI.test.ts); null: no effort control */
let effortView: any = null;
const effortAsks: any[] = [];
const store: any = { runtime: {} };

installNativeStub({
  momoChat: {
    mainChat: async () => {
      opened.push('main');
      if (openFails) throw new Error('no harness');
      return { chatId: mainId, warning: null };
    },
    onBrainChanged: (cb: any) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getBrain: async () => {
      opened.push('brain');
      if (readFails) throw new Error('offline');
      return brain;
    },
    setBrain: (next: any) => (sets.push(next), reply(next)),
  },
});
stubStore({
  toast: (text: string, kind = 'info') => toasts.push([text, kind]),
  toastFailure: (what: string) => (e: any) => toasts.push([`${what}: ${e.message}`, 'error']),
  useStore: (sel: (s: any) => unknown) => sel(store),
});
mock.module('../src/components/momo/brainEffort.ts', {
  namedExports: {
    useBrainEffort: (b: any, hh: any, chatId: any, setEffort: any) => {
      effortAsks.push([b?.harness ?? null, hh, chatId]);
      return effortView && { pick: (e: string) => setEffort(b, e), ...effortView };
    },
  },
});
mock.module('../src/components/harnessPicker/EffortPanel.tsx', {
  namedExports: {
    MoreRow: ({ desc, onClick }: any) => h('button', { onClick }, `more ${desc}`),
    EffortPanel: (p: any) =>
      h(
        'div',
        { 'data-panel': p.effort ?? '', 'data-open': String(p.open), 'data-label': p.labelOf?.('x') ?? '' },
        p.model,
        h('button', { onClick: () => p.onEffort('max') }, 'effort max'),
        p.onReset ? h('button', { onClick: p.onReset }, 'reset effort') : null,
        h('button', { onClick: p.onBack }, 'panel back'),
        p.children,
      ),
  },
});
mock.module('../src/lib/flags.ts', { namedExports: { useEnabledHarnesses: () => ['codex', 'claude'] } });
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    useHarnessModels: (hh: string) =>
      noModels
        ? []
        : hh === 'claude'
          ? [
              { id: 'haiku', label: 'Haiku' },
              { id: 'opus', label: 'Opus', isDefault: true },
            ]
          : [{ id: 'gpt-x', label: 'GPT X' }],
  },
});
mock.module('../src/session/harness/useAccountView.ts', {
  namedExports: { useAccountView: () => ({ accounts: [{ account: { id: 'du@work' }, name: 'du@work.com' }] }) },
});
mock.module('../src/session/harness/acp.ts', { namedExports: { basicLabel: (id: string) => `Basic ${id}` } });
mock.module('../src/components/ui/Popover.tsx', {
  namedExports: {
    useAnchor: popoverExports.useAnchor,
    // each popover can be dismissed (Escape, a click outside) by its close button
    Popover: ({ open, children, onClose, placement }: any) =>
      open ? h('div', { 'data-popover': placement }, children, h('button', { onClick: onClose }, `close ${placement}`)) : null,
  },
});
mock.module('../src/components/ui/MenuList.tsx', {
  namedExports: {
    MenuList: ({ children, label, onBack }: any) =>
      h('div', { role: 'menu', 'aria-label': label }, children, onBack ? h('button', { onClick: onBack }, `back ${label}`) : null),
  },
});
mock.module('../src/components/ui/icons.tsx', { namedExports: { ChevronDown: () => null } });
mock.module('../src/components/harnessPicker/badges.tsx', {
  namedExports: {
    HarnessIcon: ({ h: id }: any) => h('i', { 'data-icon': id }),
    BasicHarnessIcon: ({ id }: any) => h('i', { 'data-icon': `acp:${id}` }),
  },
});
mock.module('../src/components/harnessPicker/BasicPicker.tsx', {
  namedExports: {
    BasicRows: ({ current, onPick, momo }: any) =>
      h('button', { 'data-current': current ?? '', 'data-momo': String(momo), onClick: () => onPick('kimi') }, 'row kimi'),
  },
});
mock.module('../src/components/harnessPicker/rows.tsx', {
  namedExports: {
    HarnessRow: ({ h: id, current, rowRef, onHover, chatId }: any) =>
      h(
        'button',
        {
          ref: rowRef,
          'data-current': String(current),
          'data-chat': chatId ?? '',
          onClick: (e: any) => onHover(id, e.currentTarget, false),
        },
        `row ${id}`,
      ),
    AccountList: ({ h: id, onSwitch, chatId, unavailable }: any) =>
      h(
        'button',
        {
          'data-chat': chatId ?? '',
          'data-key-note': unavailable({ kind: 'apiKey' }) ?? '',
          onClick: () => onSwitch({ id: `${id}-acct` }),
        },
        `account ${id}`,
      ),
    ModelList: ({ h: id, currentModel, onPick }: any) =>
      h('button', { 'data-current': currentModel ?? '', onClick: () => onPick({ id: `${id}-m`, label: `${id} model` }) }, `model ${id}`),
  },
});

const { BrainChip } = await import('../src/components/momo/BrainChip.tsx');

const chip = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="MoMo\'s brain"]')!;
async function open() {
  const r = await render(h(BrainChip));
  await flush();
  await click(chip(r.host));
  return r;
}
const reset = () => {
  toasts.length = 0;
  sets.length = 0;
  readFails = false;
  openFails = false;
  mainId = 'momo-chat';
  opened.length = 0;
  noModels = false;
  effortView = null;
  effortAsks.length = 0;
  store.runtime = {};
  brain = { harness: 'claude', account: 'du@work', model: 'opus', modelLabel: null };
  reply = async (next) => ({ brain: { modelLabel: null, ...next }, chatId: 'c', applied: 'now', warning: null });
};

test('the chip names the harness, model and account; a basic harness by its name', async () => {
  reset();
  const r = await render(h(BrainChip));
  await flush();
  assert.equal(chip(r.host).textContent, 'Claude Code · Opus');
  await r.unmount();
  // a model the list doesn't have: its saved label, else its id; an account it doesn't know: left out
  brain = { harness: 'codex', account: 'gone', model: 'gpt-5', modelLabel: 'GPT-5' };
  const c = await render(h(BrainChip));
  await flush();
  assert.equal(chip(c.host).textContent, 'Codex · GPT-5');
  await c.unmount();
  brain = { harness: 'codex', account: null, model: 'gpt-5', modelLabel: null };
  const d = await render(h(BrainChip));
  await flush();
  assert.equal(chip(d.host).textContent, 'Codex · gpt-5');
  await d.unmount();
  brain = { harness: 'acp:kimi', account: null, model: null, modelLabel: null };
  const b = await render(h(BrainChip));
  await flush();
  assert.equal(chip(b.host).textContent, 'Basic kimi');
  assert.ok(b.host.querySelector('[data-icon="acp:kimi"]'));
  await b.unmount();
});

test('nothing shows until the brain is read; a failed read is told', async () => {
  reset();
  readFails = true;
  const r = await render(h(BrainChip));
  await flush();
  assert.equal(chip(r.host), null);
  assert.deepEqual(toasts, [["Couldn't read MoMo's brain: offline", 'error']]);
  await r.unmount();
  // an answer after the chip is gone changes nothing
  readFails = false;
  const late = await render(h(BrainChip));
  await late.unmount();
  await flush();
  // no brain picked yet (MoMo's page makes the main chat first, which picks the default): nothing to show
  brain = null;
  const none = await render(h(BrainChip));
  await flush();
  assert.equal(chip(none.host), null);
  await none.unmount();
});

test('a model on the brain’s harness keeps its account; on another harness it starts from that harness’s defaults', async () => {
  reset();
  const r = await open();
  assert.equal(byText(r.host, 'row claude').dataset.current, 'true');
  assert.equal(byText(r.host, 'row codex').dataset.current, 'false');
  assert.equal(byText(r.host, 'row kimi').dataset.current, '');
  // MoMo's menu: a basic harness its quirks can't confine shows off (#2278)
  assert.equal(byText(r.host, 'row kimi').dataset.momo, 'true');
  await click(byText(r.host, 'row claude'));
  assert.equal(byText(r.host, 'model claude').dataset.current, 'opus');
  await click(byText(r.host, 'model claude'));
  assert.deepEqual(sets.at(-1), { harness: 'claude', account: 'du@work', model: 'claude-m', modelLabel: 'claude model' });
  // the menu closed with the pick
  assert.equal(r.host.querySelector('[role=menu]'), null);
  assert.deepEqual(toasts, []);
  await click(chip(r.host));
  await click(byText(r.host, 'row codex'));
  assert.equal(byText(r.host, 'model codex').dataset.current, '');
  await click(byText(r.host, 'model codex'));
  assert.deepEqual(sets.at(-1), { harness: 'codex', account: null, model: 'codex-m', modelLabel: 'codex model' });
  await r.unmount();
});

test('an account on the brain’s harness keeps its model; on another harness it starts from that harness’s default model', async () => {
  reset();
  brain = { harness: 'claude', account: null, model: 'opus', modelLabel: 'Opus' };
  const r = await open();
  await click(byText(r.host, 'row claude'));
  await click(byText(r.host, 'account claude'));
  assert.deepEqual(sets.at(-1), { harness: 'claude', account: 'claude-acct', model: 'opus', modelLabel: 'Opus' });
  await click(chip(r.host));
  await click(byText(r.host, 'row codex'));
  await click(byText(r.host, 'account codex'));
  // the harness's default model, else its first
  assert.deepEqual(sets.at(-1), { harness: 'codex', account: 'codex-acct', model: 'gpt-x', modelLabel: 'GPT X' });
  await click(chip(r.host));
  await click(byText(r.host, 'row claude'));
  await click(byText(r.host, 'account claude'));
  // still on Claude Code (the answer kept the brain as asked): its model stays
  assert.deepEqual(sets.at(-1), { harness: 'claude', account: 'claude-acct', model: 'opus', modelLabel: 'Opus' });
  // a harness whose models haven't loaded: no model, which main asks the user for
  noModels = true;
  brain = { harness: 'codex', account: null, model: 'gpt-x', modelLabel: null };
  const c = await open();
  await click(byText(c.host, 'row claude'));
  await click(byText(c.host, 'account claude'));
  assert.deepEqual(sets.at(-1), { harness: 'claude', account: 'claude-acct', model: null, modelLabel: null });
  await c.unmount();
  await r.unmount();
});

test('a basic harness names no account or model; how the change reaches the chat is told, and a failure too', async () => {
  reset();
  const r = await open();
  reply = async (next) => ({ brain: { modelLabel: null, ...next }, chatId: 'n', applied: 'newChat', previous: 'c', warning: null });
  await click(byText(r.host, 'row kimi'));
  assert.deepEqual(sets.at(-1), { harness: 'acp:kimi', account: null, model: null });
  assert.equal(chip(r.host).textContent, 'Basic kimi');
  assert.deepEqual(toasts.at(-1), ['MoMo started a new chat on its new brain', 'info']);
  await click(chip(r.host));
  assert.equal(byText(r.host, 'row kimi').dataset.current, 'kimi');
  reply = async (next) => ({ brain: { modelLabel: null, ...next }, chatId: 'c', applied: 'nextMessage', warning: null });
  await click(byText(r.host, 'row claude'));
  await click(byText(r.host, 'model claude'));
  assert.deepEqual(toasts.at(-1), ['MoMo switches with its next message', 'info']);
  await click(chip(r.host));
  await click(byText(r.host, 'row claude'));
  reply = async (next) => ({ brain: { modelLabel: null, ...next }, chatId: 'c', applied: 'now', warning: 'That account was removed' });
  await click(byText(r.host, 'account claude'));
  assert.deepEqual(toasts.at(-1), ['That account was removed', 'error']);
  await click(chip(r.host));
  await click(byText(r.host, 'row codex'));
  reply = async () => {
    throw new Error('MoMo is working');
  };
  await click(byText(r.host, 'model codex'));
  assert.deepEqual(toasts.at(-1), ["Couldn't change MoMo's brain: MoMo is working", 'error']);
  await r.unmount();
});

test('two quick changes: the later one’s answer is the one shown, whichever settles first', async () => {
  reset();
  const r = await open();
  const answers: ((v: any) => void)[] = [];
  reply = (next) =>
    new Promise((resolve) =>
      answers.push(() => resolve({ brain: { modelLabel: null, ...next }, chatId: 'c', applied: 'now', warning: null })),
    );
  await click(byText(r.host, 'row codex'));
  await click(byText(r.host, 'model codex'));
  await click(chip(r.host));
  await click(byText(r.host, 'row kimi'));
  await act(async () => answers[1](null));
  await flush();
  await act(async () => answers[0](null));
  await flush();
  assert.equal(chip(r.host).textContent, 'Basic kimi');
  // the flyout and the menu are each dismissed on their own
  await click(chip(r.host));
  await click(byText(r.host, 'row codex'));
  await click(byText(r.host, 'close right-start'));
  assert.equal(maybeText(r.host, 'model codex'), null);
  // and the flyout's own Back (the left arrow) leaves the harness list open
  await click(byText(r.host, 'row codex'));
  await click(byText(r.host, 'back Codex'));
  assert.equal(maybeText(r.host, 'model codex'), null);
  assert.ok(maybeText(r.host, 'row codex'));
  await click(byText(r.host, 'close top-end'));
  assert.equal(maybeText(r.host, 'row codex'), null);
  await r.unmount();
});

test('MoMo’s chat opens first (its first start picks the default brain), then the brain is read; a failed open is told', async () => {
  reset();
  const r = await render(h(BrainChip));
  await flush();
  assert.deepEqual(opened, ['main', 'brain']);
  assert.equal(chip(r.host).textContent, 'Claude Code · Opus');
  await r.unmount();
  reset();
  openFails = true;
  const f = await render(h(BrainChip));
  await flush();
  assert.deepEqual(toasts, [["Couldn't open MoMo's chat: no harness", 'error']]);
  // the brain is still read
  assert.deepEqual(opened, ['main', 'brain']);
  await f.unmount();
});

test('a change made in another window shows here; the chip stops listening when it goes', async () => {
  reset();
  const r = await render(h(BrainChip));
  await flush();
  await act(async () => [...listeners].forEach((l) => l({ harness: 'acp:kimi', account: null, model: null, modelLabel: null })));
  assert.equal(chip(r.host).textContent, 'Basic kimi');
  await r.unmount();
  assert.equal(listeners.size, 0);
});

test('a refused change shows the brain main has now, not the one the chip showed', async () => {
  reset();
  const r = await open();
  reply = async () => {
    brain = { harness: 'codex', account: null, model: 'gpt-x', modelLabel: null };
    throw new Error('MoMo is working');
  };
  await click(byText(r.host, 'row codex'));
  await click(byText(r.host, 'model codex'));
  assert.deepEqual(toasts.at(-1), ["Couldn't change MoMo's brain: MoMo is working", 'error']);
  assert.equal(chip(r.host).textContent, 'Codex · GPT X');
  await r.unmount();
});

test('on the brain’s harness the rows know MoMo’s chat: its login is marked and only its billing lane is listed', async () => {
  reset();
  const r = await open();
  assert.equal(byText(r.host, 'row claude').dataset.chat, 'momo-chat');
  assert.equal(byText(r.host, 'row codex').dataset.chat, '');
  await click(byText(r.host, 'row claude'));
  assert.equal(byText(r.host, 'account claude').dataset.chat, 'momo-chat');
  await click(byText(r.host, 'row codex'));
  assert.equal(byText(r.host, 'account codex').dataset.chat, '');
  // a Codex API key can't be MoMo's (#2308): its row says so; another harness's key can
  assert.equal(byText(r.host, 'account codex').dataset.keyNote, 'MoMo needs a ChatGPT sign-in on Codex');
  await click(byText(r.host, 'row claude'));
  assert.equal(byText(r.host, 'account claude').dataset.keyNote, '');
  await r.unmount();
});

test('the rows follow MoMo to a new main chat, made here or in another window', async () => {
  reset();
  const r = await open();
  // here: a change that started a new main chat
  brain = { harness: 'codex', account: null, model: 'gpt-x', modelLabel: null };
  reply = async (next) => ({
    brain: { modelLabel: null, ...next },
    chatId: 'momo-chat-2',
    applied: 'newChat',
    previous: 'momo-chat',
    warning: null,
  });
  await click(byText(r.host, 'row codex'));
  await click(byText(r.host, 'model codex'));
  await click(chip(r.host));
  assert.equal(byText(r.host, 'row codex').dataset.chat, 'momo-chat-2');
  // a saved-only answer (no main chat) keeps the one it has
  reply = async (next) => ({ brain: { modelLabel: null, ...next }, chatId: null, applied: 'saved', warning: null });
  await click(byText(r.host, 'row codex'));
  await click(byText(r.host, 'model codex'));
  await click(chip(r.host));
  assert.equal(byText(r.host, 'row codex').dataset.chat, 'momo-chat-2');
  // another window: the event carries the brain, and the chip asks which chat is MoMo's now
  mainId = 'momo-chat-3';
  await act(async () => [...listeners].forEach((l) => l({ harness: 'codex', account: null, model: 'gpt-x', modelLabel: null })));
  await flush();
  assert.equal(byText(r.host, 'row codex').dataset.chat, 'momo-chat-3');
  // and asking failed: told, and the chat it had stays
  openFails = true;
  await act(async () => [...listeners].forEach((l) => l({ harness: 'codex', account: null, model: 'gpt-x', modelLabel: null })));
  await flush();
  assert.deepEqual(toasts.at(-1), ["Couldn't open MoMo's chat: no harness", 'error']);
  assert.equal(byText(r.host, 'row codex').dataset.chat, 'momo-chat-3');
  await r.unmount();
  assert.equal(listeners.size, 0);
});

test('effort: More opens the effort panel; a level keeps the brain’s harness, account and model, and the panel stays open', async () => {
  reset();
  effortView = { efforts: ['low', 'high', 'max'], effort: 'high', defaultEffort: 'high' };
  const r = await open();
  // the chip names the effort, as the model picker's button does
  assert.equal(chip(r.host).textContent, 'Claude Code · OpusHigh');
  assert.deepEqual(effortAsks.at(-1), ['claude', 'claude', 'momo-chat']);
  await click(byText(r.host, 'more High'));
  // the panel replaces the harness list, with the brain's harness and model as its head
  assert.equal(maybeText(r.host, 'row claude'), null);
  const panel = r.host.querySelector<HTMLElement>('[data-panel]')!;
  assert.equal(panel.dataset.panel, 'high');
  assert.equal(panel.dataset.open, 'true');
  assert.match(panel.textContent!, /Claude Code · Opus/);
  assert.match(panel.textContent!, /For MoMo's replies\. Background work stays on Low\./);
  assert.doesNotMatch(panel.textContent!, /Applies from the next message/);
  await click(byText(r.host, 'effort max'));
  assert.deepEqual(sets.at(-1), { harness: 'claude', account: 'du@work', model: 'opus', modelLabel: null, effort: 'max' });
  // still open on the panel: a slider moves through levels
  assert.ok(r.host.querySelector('[data-panel]'));
  await click(byText(r.host, 'reset effort'));
  assert.equal(sets.at(-1).effort, 'high');
  // back to the harness list, and closing the menu starts the next open there
  await click(byText(r.host, 'panel back'));
  assert.ok(maybeText(r.host, 'row claude'));
  await click(byText(r.host, 'more High'));
  await click(byText(r.host, 'close top-end'));
  await click(chip(r.host));
  assert.ok(maybeText(r.host, 'row claude'));
  await r.unmount();
});

test('effort: during a turn the panel says when it applies; a harness without a default has no reset; none: no More row', async () => {
  reset();
  store.runtime = { 'momo-chat': { activeTurnId: 't1' } };
  brain = { harness: 'acp:kimi', account: null, model: null, modelLabel: null };
  effortView = {
    efforts: ['quick', 'deep'],
    effort: null,
    defaultEffort: null,
    labelOf: (id: string) => `Level ${id}`,
    pick: () => undefined,
  };
  const r = await open();
  assert.deepEqual(effortAsks.at(-1), ['acp:kimi', null, 'momo-chat']);
  // no effort yet: the row has a generic line, and the chip names none
  assert.equal(chip(r.host).textContent, 'Basic kimi');
  await click(byText(r.host, 'more Effort'));
  const panel = r.host.querySelector<HTMLElement>('[data-panel]')!;
  assert.equal(panel.dataset.label, 'Level x');
  assert.match(panel.textContent!, /Basic kimi/);
  assert.match(panel.textContent!, /Applies from the next message/);
  assert.equal(maybeText(r.host, 'reset effort'), null);
  await r.unmount();
  // a named level goes by the harness's own name
  effortView = { ...effortView, effort: 'deep' };
  const n = await render(h(BrainChip));
  await flush();
  assert.equal(chip(n.host).textContent, 'Basic kimiLevel deep');
  await n.unmount();
  reset();
  const none = await open();
  assert.equal(maybeText(none.host, 'more Effort'), null);
  assert.equal(none.host.querySelector('[data-panel]'), null);
  await none.unmount();
});
