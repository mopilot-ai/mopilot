// An open chat's Account row: shown only where it is a choice and the Mac can set it, names the login in use, and sets it with chat.account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/register.ts';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { useState } from 'react';
import { scripted } from './support/phone/m3';
const sheetPath = '../mobile/src/components/ChatModelSheet';
const hookPath = '../mobile/src/remote/useChatControls';
const clientPath = '../mobile/src/remote/client';
const controlsPath = '../mobile/src/remote/controls';
const { ChatModelPill, ChatModelSheets } = await import(sheetPath);
const { useChatControls } = await import(hookPath);
const { ownedRequest, readOptions } = await import(clientPath);
const { setChatAccount } = await import(controlsPath);

const METHODS = ['options.get', 'options.set', 'chat.switch', 'chats.pin', 'chat.account'];
const MODELS = [{ id: 'm1', label: 'M1', efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low' }];
const LOGINS = [
  { id: 'work', label: 'Work', loggedIn: true },
  { id: 'old', label: 'Old', loggedIn: false },
];

function mac(o: { methods?: string[]; extra?: any; refuse?: string } = {}) {
  const st = { account: { id: 'work', pinned: true, serving: 'Work' } as any };
  const { runtime, calls } = scripted((method, p) => {
    if (method === 'machine.hello') return { capabilities: { methods: o.methods ?? METHODS, permissionCeiling: 'auto-review' } };
    if (method === 'options.get')
      return {
        models: MODELS,
        model: 'm1',
        effort: 'low',
        harness: 'Claude Code',
        harnessId: 'claude',
        permission: { value: 'default', rows: [] },
        perChat: true,
        accounts: LOGINS,
        account: st.account,
        ...o.extra,
      };
    if (method === 'harnesses.list') return { harnesses: [{ id: 'claude', label: 'Claude Code' }] };
    if (method === 'chat.account') {
      if (o.refuse) throw new Error(o.refuse);
      st.account = { id: p.account, pinned: p.account !== null, serving: p.account ? 'Work' : 'Home' };
      return { chatId: p.chatId, account: p.account, pinned: p.account !== null };
    }
    return undefined;
  });
  return { runtime, calls };
}

let mounted: any;
test.afterEach(async () => {
  if (mounted) await act(async () => mounted.root.unmount());
  mounted?.host.remove();
  mounted = null;
});
async function mount(runtime: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted = { host, root };
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
        failed: (m: string) => failures.push(m),
        sheet,
        setSheet,
      }),
    );
  };
  await act(async () => root.render(createElement(Probe)));
  await flush();
  await click('Model, M1 Low');
  return { host, failures };
}

test('a pinned chat shows its login, lists Automatic and the logins, and a pick goes to the Mac and comes back as the new state', async () => {
  const m = mac();
  const v = await mount(m.runtime);
  assert.match(v.host.textContent!, /Account/);
  await click('Account, Work');
  assert.match(v.host.textContent!, /Automatic/);
  assert.match(v.host.textContent!, /Old.*Sign in on your Mac/);
  await click('Automatic');
  assert.deepEqual(m.calls.filter(([n]) => n === 'chat.account').at(-1), ['chat.account', { chatId: 'c', account: null }]);
  await flush();
  await click('Account, Automatic');
  assert.match(v.host.textContent!, /Now on Home/);
  assert.ok(document.querySelector('button[aria-label="Automatic, Now on Home"]'), 'the login in use is in the row\u2019s spoken label');
  await click('Work');
  assert.deepEqual(m.calls.filter(([n]) => n === 'chat.account').at(-1), ['chat.account', { chatId: 'c', account: 'work' }]);
  await flush();
  await click('Account, Work');
  assert.ok(
    document.querySelector('button[aria-label="Automatic"]'),
    'a chat pinned to a login names none under Automatic, which would not use it',
  );
  assert.equal(document.querySelector('button[aria-label^="Automatic, Now on"]'), null);
});

test('the Mac’s refusal reaches the chat in its own words', async () => {
  const v = await mount(mac({ refuse: 'Codex can’t put a chat on its own account now.' }).runtime);
  await click('Account, Work');
  await click('Automatic');
  await flush();
  assert.deepEqual(v.failures, ['Codex can’t put a chat on its own account now.']);
});

test('no Account row where it would not work: an older Mac, an agent that cannot pin, no login to pick, a Mac that sends none', async () => {
  for (const o of [
    { methods: METHODS.filter((m) => m !== 'chat.account') },
    { extra: { perChat: false } },
    { extra: { perChat: undefined } },
    { extra: { accounts: [{ id: 'old', label: 'Old', loggedIn: false }] } },
    { extra: { accounts: undefined, account: undefined } },
  ]) {
    const v = await mount(mac(o).runtime);
    assert.doesNotMatch(v.host.textContent!, /Account/, JSON.stringify(o));
    await act(async () => mounted.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
});

test('the reader keeps the chat’s login and whether it can pin; the writer insists on the Mac’s echo', async () => {
  const o = readOptions(
    { models: [], account: { id: 'a', pinned: true, serving: 'A' }, perChat: true, permission: { rows: [] } },
    'auto-review',
  );
  assert.deepEqual([o.account, o.perChat], [{ id: 'a', pinned: true, serving: 'A' }, true]);
  const free = readOptions({ models: [], account: { id: 5, serving: 7 }, permission: { rows: [] } }, 'auto-review');
  assert.deepEqual([free.account, free.perChat], [{ id: null, pinned: false, serving: null }, undefined]);
  assert.equal(readOptions({ models: [], permission: { rows: [] } }, 'auto-review').account, undefined);
  const echo = (reply: unknown) => ownedRequest(scripted(() => reply).runtime);
  await setChatAccount(echo({ chatId: 'c', account: 'a' }), 'c', 'a');
  await setChatAccount(echo({ chatId: 'c', account: null }), 'c', null);
  await assert.rejects(setChatAccount(echo({ chatId: 'c', account: 'b' }), 'c', 'a'));
  await assert.rejects(setChatAccount(echo(undefined), 'c', null));
});
