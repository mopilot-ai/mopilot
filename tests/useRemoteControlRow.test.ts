// useRemoteControlRow (src/session/useRemoteControlRow.ts): the switch a chat shows and what pressing it does, by the chat's harness:
// Claude Code's session link (a turn first), Codex's whole-computer link (asked first), and a harness without one says why.
// The last capability answer stands while the next one is read.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h } from 'react';
import { mount } from './support/composer-kit.ts';
import { fakeStore } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ runtime: { t1: { turns: [{}] } } });
const navigations: unknown[] = [];
stubStore({ ...store.exports, navigate: (route: unknown) => void navigations.push(route) });
let session: any = {};
let caps: any = {};
let codexView: any = null;
const claudeSets: [string, boolean][] = [];
const codexSets: boolean[] = [];
const codexActive: boolean[] = [];
const setCodex = async (on: boolean) => void codexSets.push(on);
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => session,
    useSessionField: (id: any, pick: any) => pick(((() => session) as (id: any) => any)(id)),
  },
});
mock.module('../src/store/session/useCaps.ts', { namedExports: { useChatCaps: () => caps } });
mock.module('../src/session/harness/claude/remoteControl.ts', {
  namedExports: { setRemoteControl: async (id: string, on: boolean) => void claudeSets.push([id, on]) },
});
mock.module('../src/session/harness/codexRemoteControl.ts', {
  namedExports: { setCodexRemoteControl: setCodex, useCodexRemoteControl: (active: boolean) => (codexActive.push(active), codexView) },
});
const { useRemoteControlRow } = await import('../src/session/useRemoteControlRow.ts');

const loaded = (kind: string, why?: object) => ({ loaded: true, kind, caps: { remoteControl: { state: why ? 'none' : 'native', why } } });
const notLoaded = {
  loaded: false,
  kind: 'codex',
  caps: { remoteControl: { state: 'absent', why: { layer: 'harness', code: 'harness.undeclared' } } },
};
let row: any;
const Probe = ({ id }: { id: string }) => ((row = useRemoteControlRow(id)), null);
beforeEach(() => {
  store.set({ runtime: { t1: { turns: [{}] }, t2: { turns: [{}] } } });
  session = { remoteControl: null };
  codexView = null;
  claudeSets.length = 0;
  codexSets.length = 0;
  codexActive.length = 0;
});

test("a chat whose harness can't link gets the reason from its capability, and presses nothing", async () => {
  caps = loaded('acp:kimi', { layer: 'harness', code: 'harness.noRemoteControl' });
  const m = await mount(h(Probe, { id: 't1' }));
  assert.equal(row.visible, false);
  assert.equal(row.disabled, true);
  assert.match(row.note, /Not available for this chat/);
  assert.equal(row.confirmOn, false);
  assert.equal(codexActive.at(-1), false);
  await m.unmount();
});

test("a Claude chat shows its session's link, has to have run a turn, and presses its own session", async () => {
  session = { remoteControl: { state: 'on', url: 'https://claude.ai/code/s', error: null, wanted: true } };
  caps = loaded('claude');
  const m = await mount(h(Probe, { id: 't1' }));
  assert.equal(row.note, 'Linked to claude.ai');
  assert.equal(row.url, 'https://claude.ai/code/s');
  assert.equal(row.confirmOn, false);
  assert.equal(row.manage, undefined);
  row.set(false);
  assert.deepEqual(claudeSets, [['t1', false]]);
  assert.equal(codexActive.at(-1), false);
  await act(async () => store.set({ runtime: { t1: { turns: [] } } }));
  assert.equal(row.note, 'Send a message first');
  await act(async () => store.set({ runtime: {} }));
  assert.equal(row.disabled, true);
  await m.unmount();
});

test("a Codex chat shows the computer's link, needs no turn, asks before turning it on, and presses Codex", async () => {
  caps = loaded('codex');
  store.set({ runtime: { t1: { turns: [] } } });
  codexView = { status: 'connected', environmentId: 'env1', error: null };
  const m = await mount(h(Probe, { id: 't1' }));
  assert.deepEqual(
    { on: row.on, disabled: row.disabled, note: row.note },
    { on: true, disabled: false, note: 'Connected · this computer' },
  );
  assert.equal(row.confirmOn, true);
  assert.equal(row.visible, true);
  assert.equal(codexActive.at(-1), true);
  row.set(true);
  assert.deepEqual(codexSets, [true]);
  assert.deepEqual(claudeSets, []);
  // its devices are managed in Settings
  row.manage();
  assert.deepEqual(navigations, [{ name: 'settings', section: 'connections' }]);
  // a Codex login that is not a ChatGPT one cannot
  caps = loaded('codex', { layer: 'account', code: 'account.remoteControlNeedsChatGPT' });
  await m.render(h(Probe, { id: 't1' }));
  assert.equal(row.disabled, true);
  assert.equal(row.visible, true, 'the switch can explain how to recover a supported capability');
  assert.match(row.note, /signed-in ChatGPT account/);
  await m.unmount();
});

test('while capabilities are read again the last answer stands; before any, the switch is inert and silent; another chat never inherits it', async () => {
  caps = notLoaded;
  const m = await mount(h(Probe, { id: 't1' }));
  assert.deepEqual(
    { on: row.on, disabled: row.disabled, note: row.note, url: row.url },
    { on: false, disabled: true, note: null, url: null },
  );
  assert.equal(codexActive.at(-1), false);
  caps = loaded('claude');
  await m.render(h(Probe, { id: 't1' }));
  assert.equal(row.disabled, false);
  caps = notLoaded;
  await m.render(h(Probe, { id: 't1' }));
  assert.equal(row.disabled, false);
  assert.equal(codexActive.at(-1), false);
  await m.render(h(Probe, { id: 't2' }));
  assert.equal(row.disabled, true);
  assert.equal(row.note, null);
  assert.equal(row.set(true), undefined);
  assert.equal(row.confirmOn, false);
  await m.unmount();
});
