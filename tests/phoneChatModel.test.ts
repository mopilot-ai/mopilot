// The chat's model pill and its sheets: model, effort and permission picked in New chat's Select model sheet, the agent moved from the next message (and called off), one pick at a time, never full access, and what an older Mac leaves out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { useState } from 'react';
import { scripted } from './support/phone/m3';
import { deferred } from './support/async-scenarios';
const sheetPath = '../mobile/src/components/ChatModelSheet';
const hookPath = '../mobile/src/remote/useChatControls';
const clientPath = '../mobile/src/remote/client';
const { ChatModelPill, ChatModelSheets, pillWords } = await import(sheetPath);
const { useChatControls } = await import(hookPath);
const { ownedRequest } = await import(clientPath);

const ALL = ['options.get', 'options.set', 'chat.switch', 'chats.pin'];
const MODELS = [
  {
    id: 'm1',
    label: 'M1',
    efforts: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ],
    defaultEffort: 'low',
  },
  { id: 'm2', label: 'M2', efforts: [{ id: 'medium', label: 'Medium' }], defaultEffort: 'medium' },
  {
    id: 'm3',
    label: 'M3',
    efforts: [
      { id: 'low', label: 'Low' },
      { id: 'xhigh', label: 'Extra' },
    ],
    defaultEffort: 'xhigh',
  },
];
const ROWS = [
  { id: 'default', label: 'Ask', detail: 'Ask first' },
  { id: 'auto-review', label: 'Auto', detail: 'Reviewed' },
  { id: 'full-access', label: 'Full access', detail: 'No prompts' },
];

/** A Mac with one chat whose settings the phone reads and changes; `over` replaces a method's answer. */
function mac(o: { methods?: string[]; state?: Record<string, any>; over?: (method: string, params: any) => unknown } = {}) {
  const st: Record<string, any> = { model: 'm1', effort: 'low', permission: 'default', harnessId: 'claude', switching: false, ...o.state };
  // the agent the chat runs on; a pick of any other waits for the chat's next message
  const own = st.harnessId;
  const label = (id: string) => (id === 'claude' ? 'Claude Code' : 'Codex');
  const { runtime, calls, state } = scripted((method, p) => {
    const given = o.over?.(method, p);
    if (given !== undefined) return given;
    if (method === 'machine.hello') return { capabilities: { methods: o.methods ?? ALL, permissionCeiling: 'auto-review' } };
    if (method === 'options.get')
      return {
        models: MODELS,
        model: st.model,
        effort: st.effort,
        harness: label(st.harnessId),
        harnessId: st.harnessId,
        switching: st.switching,
        permission: { value: st.permission, rows: ROWS },
      };
    if (method === 'harnesses.list')
      return {
        harnesses: [
          { id: 'claude', label: 'Claude Code' },
          { id: 'codex', label: 'Codex' },
        ],
      };
    if (method === 'options.set') {
      if (p.value !== undefined) st.permission = p.value;
      else Object.assign(st, { model: p.model, effort: p.effort });
      return { chosen: true };
    }
    if (method === 'chats.pin') return { pinned: p.pinned };
    if (method === 'chat.switch') {
      st.switching = p.harness !== own;
      st.harnessId = p.harness;
      return { switched: true };
    }
    return undefined;
  });
  return { runtime, calls, st, state };
}

const mounted: any[] = [];
/** The pill as the chat draws it: its controls read by the hook, refusals collected. */
async function mount(runtime: any, ownHarness: string | undefined = 'claude') {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const failures: string[] = [];
  const request = ownedRequest(runtime);
  const Probe = () => {
    const s = useChatControls(request, 'c');
    const [sheet, setSheet] = useState<any>(null);
    return createElement(
      'div',
      null,
      createElement(ChatModelPill, { controls: s.controls, open: () => setSheet('model') }),
      createElement(ChatModelSheets, {
        request,
        chatId: 'c',
        controls: s.controls,
        reload: s.reload,
        ownHarness,
        failed: (m: string) => failures.push(m),
        clear: (m: string) => failures.includes(m) && failures.splice(failures.lastIndexOf(m), 1),
        sheet,
        setSheet,
      }),
    );
  };
  await act(async () => root.render(createElement(Probe)));
  await flush();
  return { host, root, failures };
}
const text = (host: HTMLElement) => host.textContent!;
const rows = (host: HTMLElement) => [...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));

test('the pill names the model and its effort and opens Select model with the Mac’s settings, never full access', async () => {
  const m = mac();
  const v = await mount(m.runtime);
  assert.ok(v.host.querySelector('button[aria-label="Model, M1 Low"]'));
  await click('Model, M1 Low');
  assert.match(text(v.host), /Select model/);
  assert.deepEqual(rows(v.host).slice(1), [
    'Dismiss',
    'Close',
    'M1',
    'M2',
    'M3',
    'Effort, Recommended, Low',
    'Agent, Claude Code',
    'Permissions, Ask',
  ]);
  await click('Permissions, Ask');
  assert.doesNotMatch(text(v.host), /Full access/);
  await click('Auto');
  assert.deepEqual(
    m.calls.find(([c]) => c === 'options.set'),
    ['options.set', { chatId: 'c', value: 'auto-review' }],
  );
  assert.equal(m.calls.filter(([c]) => c === 'options.get').length, 2, 'the Mac’s answer is read back');
});

test('a model keeps the effort it has, else takes its own default; Effort changes only the effort', async () => {
  const m = mac();
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M3');
  assert.deepEqual(m.calls.filter(([c]) => c === 'options.set').at(-1), ['options.set', { chatId: 'c', model: 'm3', effort: 'low' }]);
  await click('Model, M3 Low');
  await click('M2');
  assert.deepEqual(m.calls.filter(([c]) => c === 'options.set').at(-1), ['options.set', { chatId: 'c', model: 'm2', effort: 'medium' }]);
  await click('Model, M2 Medium');
  await click('Effort, Recommended, Medium');
  await click('Medium');
  assert.deepEqual(m.calls.filter(([c]) => c === 'options.set').at(-1), ['options.set', { chatId: 'c', model: 'm2', effort: 'medium' }]);
  void v;
});

test('a model with no default and no matching effort gets none', async () => {
  const m = mac({
    over: (method) =>
      method === 'options.get'
        ? {
            models: [
              { id: 'a', label: 'A', efforts: [{ id: 'x', label: 'X' }] },
              { id: 'b', label: 'B', efforts: [] },
            ],
            model: 'a',
            effort: 'x',
            harnessId: 'claude',
            permission: { value: 'default', rows: ROWS },
          }
        : undefined,
  });
  const v = await mount(m.runtime);
  await click('Model, A X');
  await click('B');
  assert.deepEqual(m.calls.filter(([c]) => c === 'options.set').at(-1), ['options.set', { chatId: 'c', model: 'b', effort: null }]);
  void v;
});

test('a refused pick says why, and the sheet shows the Mac’s settings again', async () => {
  const m = mac({ over: (method) => (method === 'options.set' ? Promise.reject(new Error('Allow this from your Mac.')) : undefined) });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  await flush();
  assert.deepEqual(v.failures, ['Allow this from your Mac.']);
  assert.ok(v.host.querySelector('button[aria-label="Model, M1 Low"]'), 'nothing changed on the Mac');
});

test('a pick that works takes back the line a refused one set (#4807)', async () => {
  let refuse = true;
  const m = mac({
    over: (method) => (method === 'options.set' && refuse ? Promise.reject(new Error('Allow this from your Mac.')) : undefined),
  });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  await flush();
  assert.deepEqual(v.failures, ['Allow this from your Mac.']);
  refuse = false;
  await click('Model, M1 Low');
  await click('M2');
  await flush();
  assert.deepEqual(v.failures, [], 'the next pick that works took its own line back');
});

test('one pick at a time: a second while the first saves changes nothing', async () => {
  const saving = deferred<unknown>();
  const m = mac({ over: (method) => (method === 'options.set' ? saving.promise : undefined) });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  // the pill shows the pick at once (#4986); a second one waits for the first's answer (phoneChatOptimisticPicks)
  await click('Model, M2 Medium');
  await click('M3');
  assert.equal(m.calls.filter(([c]) => c === 'options.set').length, 1);
  await act(async () => saving.resolve({ chosen: true }));
  await flush();
  void v;
});

test('the agent moves with the next message, which the sheet says, and Undo calls it off', async () => {
  const m = mac();
  const v = await mount(m.runtime, 'claude');
  await click('Model, M1 Low');
  await click('Agent, Claude Code');
  assert.match(text(v.host), /Agent/);
  await click('Claude Code, current agent');
  assert.equal(
    m.calls.some(([c]) => c === 'chat.switch'),
    false,
    'its own agent moves nothing',
  );
  await click('Model, M1 Low');
  await click('Agent, Claude Code');
  await click('Codex');
  assert.deepEqual(
    m.calls.find(([c]) => c === 'chat.switch'),
    ['chat.switch', { chatId: 'c', harness: 'codex' }],
  );
  await click('Model, M1 Low');
  await click('Agent, Codex');
  assert.match(text(v.host), /Next message continues on Codex/);
  await click('Undo, stay on Claude Code');
  assert.deepEqual(m.calls.filter(([c]) => c === 'chat.switch').at(-1), ['chat.switch', { chatId: 'c', harness: 'claude' }]);
  // ‹ goes back to Select model, and the scrim closes the sheet
  await click('Model, M1 Low');
  await click('Agent, Claude Code');
  await click('Back');
  assert.match(text(v.host), /Select model/);
  await click('Agent, Claude Code');
  await click('Dismiss');
  assert.doesNotMatch(text(v.host), /Agent/);
});

test('a waiting move with an unknown own agent cannot be called off; an agent the list does not name reads by its id', async () => {
  const m = mac({ state: { harnessId: 'acp:x', switching: true } });
  const v = await mount(m.runtime, '');
  await click('Model, M1 Low');
  await click('Agent, Codex');
  assert.match(text(v.host), /Next message continues on Codex/);
  assert.equal(v.host.querySelector('button[aria-label^="Undo"]'), null);
  const named = await mount(mac({ state: { harnessId: 'codex', switching: true } }).runtime, 'acp:gemini-cli');
  await click('Model, M1 Low');
  await click('Agent, Codex');
  assert.ok(named.host.querySelector('button[aria-label^="Undo, stay on "]'));
});

test('the chat’s account is not offered here: the sheet has no Account row even when the Mac lists accounts', async () => {
  const m = mac({
    over: (method) =>
      method === 'options.get'
        ? {
            models: MODELS,
            model: 'm1',
            effort: 'low',
            harnessId: 'claude',
            accounts: [{ id: 'a1', label: 'Work' }],
            permission: { value: 'default', rows: ROWS },
          }
        : undefined,
  });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  assert.equal(v.host.querySelector('button[aria-label^="Account"]'), null);
});

test('what an older Mac cannot set is left out of the sheet; a Mac that names no model shows no pill', async () => {
  const m = mac({ methods: ['options.get'] });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  assert.deepEqual(rows(v.host).slice(1), ['Dismiss', 'Close']);
  const none = await mount(mac({ state: { model: null } }).runtime);
  assert.equal(none.host.querySelector('button[aria-label^="Model"]'), null);
  assert.equal(pillWords(null), null);
});

test('a Mac that does not name the chat’s agent still shows the pill and the sheet, without the Agent row', async () => {
  const m = mac({ state: { harnessId: undefined } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  assert.match(text(v.host), /Select model/);
  assert.equal(v.host.querySelector('button[aria-label^="Agent"]'), null);
});

/** A Mac whose model list tags older versions `more`, as Claude Code's does. */
const TAGGED = [
  { id: 'fable', label: 'Fable 5.1', description: 'Toughest', efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high' },
  { id: 'opus', label: 'Opus 5.5', efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high' },
  { id: 'opus-4-8', label: 'Opus 4.8', efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high', more: true },
  { id: 'haiku-4-5', label: 'Haiku 4.5', efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high', more: true },
];
const tagged = (st: { model: string }) =>
  mac({
    state: st,
    over: (method) =>
      method === 'options.get'
        ? { models: TAGGED, model: st.model, effort: 'high', harnessId: 'claude', permission: { value: 'default', rows: ROWS } }
        : undefined,
  });

test('Select model lists the Mac’s current models in its order, Effort with Recommended, and More models for the rest', async () => {
  const v = await mount(tagged({ model: 'opus' }).runtime);
  await click('Model, Opus 5.5 High');
  assert.deepEqual(rows(v.host).slice(3), [
    'Fable 5.1',
    'Opus 5.5',
    'Effort, Recommended, High',
    'More models',
    'Agent, claude',
    'Permissions, Ask',
  ]);
  await click('More models');
  assert.match(text(v.host), /More models/);
  assert.deepEqual(rows(v.host).slice(3), ['Opus 4.8', 'Haiku 4.5']);
});

test('a pick from More models is made through the Mac, and the current models keep their place whichever is chosen', async () => {
  const m = tagged({ model: 'opus' });
  const v = await mount(m.runtime);
  await click('Model, Opus 5.5 High');
  await click('More models');
  await click('Opus 4.8');
  assert.deepEqual(m.calls.filter(([c]) => c === 'options.set').at(-1), [
    'options.set',
    { chatId: 'c', model: 'opus-4-8', effort: 'high' },
  ]);
  await click('Model, Opus 5.5 High');
  assert.deepEqual(rows(v.host).slice(3, 5), ['Fable 5.1', 'Opus 5.5']);
});

test('the Effort page marks the model’s default as Recommended', async () => {
  const v = await mount(tagged({ model: 'fable' }).runtime);
  await click('Model, Fable 5.1 High');
  await click('Effort, Recommended, High');
  assert.match(text(v.host), /Recommended/);
});
