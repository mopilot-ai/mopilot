// A pick in the chat's model sheet shows at once (#4986 F3): the pill, the sheet's check and the agent the chat moves to change when the person taps, not when the Mac's answer and a second read come back; a refusal or an offline Mac takes the pick back in its own words, one pick saves at a time, and the Mac's read-back replaces the pick instead of the old state flashing under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { useState } from 'react';
import { scripted } from './support/phone/m3';
import { deferred, type Deferred } from './support/async-scenarios';
const sheetPath = '../mobile/src/components/ChatModelSheet';
const hookPath = '../mobile/src/remote/useChatControls';
const clientPath = '../mobile/src/remote/client';
const { ChatModelPill, ChatModelSheets } = await import(sheetPath);
const { useChatControls } = await import(hookPath);
const { ownedRequest } = await import(clientPath);

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
  {
    id: 'm2',
    label: 'M2',
    efforts: [{ id: 'medium', label: 'Medium' }],
    defaultEffort: 'medium',
  },
  {
    id: 'm3',
    label: 'M3',
    efforts: [{ id: 'low', label: 'Low' }],
    defaultEffort: 'low',
  },
];
const ROWS = [
  { id: 'default', label: 'Ask', detail: 'Ask first' },
  { id: 'auto-review', label: 'Auto', detail: 'Reviewed' },
];
const AGENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];
const ALL = ['options.get', 'options.set', 'chat.switch', 'chat.account', 'chats.pin'];

type Hold = Partial<Record<'options.set' | 'chat.switch' | 'chat.account', Deferred<unknown>>>;
/**
 * A Mac with one chat. A held method answers when the test releases it, and applies its change then (as the real Mac does);
 * `onGet` replaces what a read answers (the second read is held to look at the moment between the answer and the read-back).
 */
function mac(
  o: {
    state?: Record<string, any>;
    hold?: Hold;
    fail?: Partial<Record<string, Error>>;
    /** the nth read answers when this is released */
    holdRead?: [number, Deferred<unknown>];
    machine?: boolean;
  } = {},
) {
  const st: Record<string, any> = {
    model: 'm1',
    effort: 'low',
    permission: 'default',
    harnessId: 'claude',
    switching: false,
    account: { id: 'work', pinned: true, serving: 'Work' },
    ...o.state,
  };
  const own = st.harnessId === 'codex' && st.switching ? 'claude' : st.harnessId;
  let gets = 0;
  const { runtime, calls } = scripted((method, p) => {
    if (method === 'machine.hello')
      return {
        capabilities: { methods: ALL, permissionCeiling: 'auto-review' },
      };
    if (method === 'options.get') {
      gets += 1;
      const held = o.holdRead?.[0] === gets ? o.holdRead[1].promise : null;
      const reply = () => ({
        models: o.machine ? [] : MODELS,
        model: o.machine ? null : st.model,
        effort: o.machine ? null : st.effort,
        harness: AGENTS.find((a) => a.id === st.harnessId)?.label,
        harnessId: st.harnessId,
        current: own,
        switching: st.switching,
        permission: { value: st.permission, rows: ROWS },
        perChat: true,
        accounts: [
          { id: 'work', label: 'Work', loggedIn: true },
          { id: 'home', label: 'Home', loggedIn: true },
        ],
        account: st.account,
        ...(o.machine && {
          machine: {
            name: 'Box',
            agents: AGENTS.map((a) => ({ ...a, state: 'ready' })),
          },
        }),
      });
      return held ? held.then(reply) : reply();
    }
    if (method === 'harnesses.list') return { harnesses: AGENTS };
    const apply = () => {
      const refused = o.fail?.[method];
      if (refused) throw refused;
      if (method === 'options.set') {
        if (p.value !== undefined) st.permission = p.value;
        else Object.assign(st, { model: p.model, effort: p.effort });
        return { chosen: true };
      }
      if (method === 'chat.switch') {
        st.switching = p.harness !== own;
        st.harnessId = p.harness;
        return { switched: true };
      }
      if (method === 'chat.account') {
        st.account = {
          id: p.account,
          pinned: p.account !== null,
          serving: p.account ? 'Work' : 'Home',
        };
        return {
          chatId: p.chatId,
          account: p.account,
          pinned: p.account !== null,
        };
      }
      return undefined;
    };
    const held = o.hold?.[method as keyof Hold];
    return held ? held.promise.then(apply) : apply();
  });
  const count = (method: string) => calls.filter(([c]) => c === method).length;
  return { runtime, calls, st, count };
}

const mounted: any[] = [];
async function mount(runtime: any, ownHarness: string | undefined = 'claude') {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const failures: string[] = [];
  const handle: { notes: (n: number) => void; closeSheet: () => void } = {
    notes: () => {},
    closeSheet: () => {},
  };
  const request = ownedRequest(runtime);
  const Probe = () => {
    const [notes, setNotes] = useState(0);
    const s = useChatControls(request, 'c', true, notes);
    const [sheet, setSheet] = useState<any>(null);
    handle.notes = setNotes;
    handle.closeSheet = () => setSheet(null);
    return createElement(
      'div',
      null,
      createElement(ChatModelPill, {
        controls: s.controls,
        open: () => setSheet('model'),
      }),
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
  return { host, failures, handle };
}
const has = (host: HTMLElement, label: string) => !!host.querySelector(`button[aria-label="${label}"]`);
const text = (host: HTMLElement) => host.textContent!;
const release = async (d: Deferred<unknown>) => {
  await act(async () => d.resolve(undefined));
  await flush();
};

test('a model pick shows in the pill at once, before the Mac answers; the Mac’s answer then costs one silent read, not a flash back', async () => {
  const write = deferred<unknown>();
  const back = deferred<unknown>();
  const m = mac({
    hold: { 'options.set': write },
    holdRead: [2, back],
  });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  assert.ok(has(v.host, 'Model, M2 Medium'), 'shown on the tap');
  assert.equal(m.count('options.get'), 1, 'nothing was read to show it');
  await release(write);
  assert.equal(m.count('options.get'), 2, 'one read-back');
  assert.equal(m.count('harnesses.list'), 1, 'the read-back is one request: the Mac’s agents are not asked for again');
  assert.ok(has(v.host, 'Model, M2 Medium'), 'the pick keeps showing while the read-back is out');
  await act(async () => back.resolve(undefined));
  await flush();
  assert.ok(has(v.host, 'Model, M2 Medium'));
  assert.deepEqual(v.failures, []);
});

test('the Mac’s read-back replaces the pick: a model it kept different shows as the Mac has it', async () => {
  const write = deferred<unknown>();
  const m = mac({ hold: { 'options.set': write } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  await act(async () => write.resolve(undefined));
  await flush();
  m.st.model = 'm3'; // the Mac chose otherwise
  await act(async () => v.handle.notes(1));
  await flush();
  assert.ok(has(v.host, 'Model, M3'));
});

test('an effort pick and a permission pick show at once, the permission in the sheet’s own row', async () => {
  const write = deferred<unknown>();
  const m = mac({ hold: { 'options.set': write } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('Effort, Recommended, Low');
  await click('High');
  assert.ok(has(v.host, 'Model, M1 High'));
  await release(write);
  const perm = deferred<unknown>();
  const p = mac({ hold: { 'options.set': perm } });
  const w = await mount(p.runtime);
  await click('Model, M1 Low');
  await click('Permissions, Ask');
  await click('Auto');
  assert.ok(has(w.host, 'Permissions, Auto'), 'the sheet’s row says the new permission before the Mac answers');
  assert.equal(p.count('options.get'), 1);
  await release(perm);
});

test('a refused pick is taken back and says the Mac’s words; the controls are read again', async () => {
  const m = mac({
    fail: { 'options.set': new Error('Allow this from your Mac.') },
  });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  await flush();
  assert.deepEqual(v.failures, ['Allow this from your Mac.']);
  assert.ok(has(v.host, 'Model, M1 Low'), 'the pill is back on what the Mac has');
  assert.equal(m.count('options.get'), 2);
});

test('a pick while the Mac is offline is taken back and says so', async () => {
  const m = mac({ fail: { 'options.set': new Error('Computer is offline') } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M3');
  await flush();
  assert.deepEqual(v.failures, ['Your computer is offline or asleep. Wake it and try again.']);
  assert.ok(has(v.host, 'Model, M1 Low'));
});

test('one pick saves at a time: a second, different pick made while the first saves waits its turn and the Mac and the sheet end on it (#4986)', async () => {
  const write = deferred<unknown>();
  const m = mac({ hold: { 'options.set': write } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  await click('Model, M2 Medium');
  await click('M3');
  assert.equal(m.count('options.set'), 1, 'one request at a time');
  assert.ok(has(v.host, 'Model, M2 Medium'), 'the first shows while it saves');
  await act(async () => write.resolve(undefined));
  await flush();
  assert.equal(m.count('options.set'), 2, 'the second goes when the first is answered');
  assert.deepEqual(m.calls.filter(([c]) => c === 'options.set').at(-1)?.[1], { chatId: 'c', model: 'm3', effort: 'low' });
  assert.equal(m.st.model, 'm3', 'the Mac ends on the second');
  assert.ok(has(v.host, 'Model, M3 Low'), 'and so does the sheet');
});

test('a second pick of another control keeps the first one’s change: both reach the Mac and both show', async () => {
  const write = deferred<unknown>();
  const m = mac({ hold: { 'options.set': write } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  await click('Model, M2 Medium');
  await click('Permissions, Ask');
  await click('Auto');
  await act(async () => write.resolve(undefined));
  await flush();
  assert.deepEqual([m.st.model, m.st.permission], ['m2', 'auto-review']);
  assert.ok(has(v.host, 'Model, M2 Medium'));
});

test('a refused first pick drops the picks made on top of it: they are not sent', async () => {
  const write = deferred<unknown>();
  const m = mac({ hold: { 'options.set': write }, fail: { 'options.set': new Error('Allow this from your Mac.') } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  await click('Model, M2 Medium');
  await click('M3');
  await act(async () => write.resolve(undefined));
  await flush();
  assert.equal(m.count('options.set'), 1);
  assert.deepEqual(v.failures, ['Allow this from your Mac.']);
  assert.ok(has(v.host, 'Model, M1 Low'));
});

test('a read that lands while a pick is saving (the chat moved) does not put the old state back under it', async () => {
  const write = deferred<unknown>();
  const m = mac({ hold: { 'options.set': write } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  await act(async () => v.handle.notes(1)); // a note arrived: the controls are read while the pick saves
  await flush();
  assert.equal(m.count('options.get'), 2);
  assert.ok(has(v.host, 'Model, M2 Medium'), 'that read still says M1');
  await release(write);
  assert.ok(has(v.host, 'Model, M2 Medium'));
});

test('closing the sheet mid-save loses nothing: the pick still settles and shows', async () => {
  const write = deferred<unknown>();
  const m = mac({ hold: { 'options.set': write } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  await act(async () => v.handle.closeSheet());
  assert.ok(has(v.host, 'Model, M2 Medium'));
  await release(write);
  assert.ok(has(v.host, 'Model, M2 Medium'));
  assert.equal(m.count('options.get'), 2);
});

test('an agent pick shows at once: the pill names the new agent and the move waits for the next message; the read-back brings its own model', async () => {
  const write = deferred<unknown>();
  const back = deferred<unknown>();
  const m = mac({
    hold: { 'chat.switch': write },
    holdRead: [2, back],
  });
  const v = await mount(m.runtime, 'claude');
  await click('Model, M1 Low');
  await click('Agent, Claude Code');
  await click('Codex');
  assert.ok(has(v.host, 'Model, Codex'), 'the pill names the agent while the model is the old agent’s');
  assert.equal(m.count('options.get'), 1);
  await click('Model, Codex');
  await click('Agent, Codex');
  assert.match(text(v.host), /Next message continues on Codex/);
  assert.ok(has(v.host, 'Undo, stay on Claude Code'));
  await release(write);
  assert.equal(m.count('options.get'), 2);
  assert.match(text(v.host), /Next message continues on Codex/);
  // the model rows are still the old agent's until the read-back: a pick of one is not sent to the new agent
  await click('Back');
  await click('M2');
  assert.equal(m.count('options.set'), 0);
  await act(async () => back.resolve(undefined));
  await flush();
  assert.ok(has(v.host, 'Model, M1 Low'), 'the new agent’s own model, as the Mac names it');
});

test('calling a held move off shows the agent the chat stays on at once and drops the line', async () => {
  const write = deferred<unknown>();
  const m = mac({
    state: { harnessId: 'codex', switching: true },
    hold: { 'chat.switch': write },
  });
  const v = await mount(m.runtime, 'claude');
  await click('Model, M1 Low');
  await click('Agent, Codex');
  assert.match(text(v.host), /Next message continues on Codex/);
  await click('Undo, stay on Claude Code');
  assert.ok(has(v.host, 'Model, Claude Code'));
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  assert.doesNotMatch(text(v.host), /Next message continues/);
  await release(write);
});

test('a refused agent move is taken back: the pill and the held line are as before, in the Mac’s words', async () => {
  const m = mac({
    fail: { 'chat.switch': new Error('Codex is not signed in.') },
  });
  const v = await mount(m.runtime, 'claude');
  await click('Model, M1 Low');
  await click('Agent, Claude Code');
  await click('Codex');
  await flush();
  assert.deepEqual(v.failures, ['Codex is not signed in.']);
  assert.ok(has(v.host, 'Model, M1 Low'));
  await click('Model, M1 Low');
  await click('Agent, Claude Code');
  assert.doesNotMatch(text(v.host), /Next message continues/);
});

test('a chat on a machine: the pill names the new agent at once and "Next message continues on …" stays right; its own agent again clears it', async () => {
  const write = deferred<unknown>();
  const m = mac({ machine: true, hold: { 'chat.switch': write } });
  const v = await mount(m.runtime, undefined);
  assert.ok(has(v.host, 'Model, Claude Code'));
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  await click('Codex');
  assert.ok(has(v.host, 'Model, Codex'));
  await click('Model, Codex');
  await click('Agent, Codex');
  assert.match(text(v.host), /Next message continues on Codex/);
  await release(write);
  assert.match(text(v.host), /Next message continues on Codex/);
  await click('Undo, stay on Claude Code');
  await click('Model, Claude Code');
  await click('Agent, Claude Code');
  assert.doesNotMatch(text(v.host), /Next message continues/);
});

test('the chat’s login shows at once: Automatic with no "Now on" until the Mac names the login it uses', async () => {
  const write = deferred<unknown>();
  const m = mac({ hold: { 'chat.account': write } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('Account, Work');
  await click('Automatic');
  assert.ok(has(v.host, 'Account, Automatic'));
  assert.equal(m.count('options.get'), 1);
  await release(write);
  await click('Account, Automatic');
  assert.match(text(v.host), /Now on Home/);
});

test('a sheet left while its pick saves: the Mac’s late answer asks for no read and settles nothing', async () => {
  const write = deferred<unknown>();
  const m = mac({ hold: { 'options.set': write } });
  const v = await mount(m.runtime);
  await click('Model, M1 Low');
  await click('M2');
  await act(async () => mounted.splice(0).forEach((old) => old.root.unmount()));
  await release(write);
  assert.equal(m.count('options.get'), 1, 'the chat was left: nothing reads for it');
  v.host.remove();
});

test('a tap on a menu row before the read-back of an agent move asks for that read again and sends nothing', async () => {
  const write = deferred<unknown>();
  const back = deferred<unknown>();
  const m = mac({ hold: { 'chat.switch': write }, holdRead: [2, back] });
  const v = await mount(m.runtime, 'claude');
  await click('Model, M1 Low');
  await click('Agent, Claude Code');
  await click('Codex');
  await release(write);
  await click('Model, Codex');
  await click('M2');
  assert.equal(m.count('options.set'), 0);
  assert.equal(m.count('options.get'), 3, 'the read is asked for again');
  await act(async () => back.resolve(undefined));
  await flush();
  assert.ok(v.host);
});

test('an own agent with no readable name is called by its id on the Undo row, and Undo shows it at once', async () => {
  const write = deferred<unknown>();
  const m = mac({ state: { harnessId: 'codex', switching: true }, hold: { 'chat.switch': write } });
  const v = await mount(m.runtime, 'acp:');
  await click('Model, M1 Low');
  await click('Agent, Codex');
  await click('Undo, stay on acp:');
  assert.ok(has(v.host, 'Model, acp:'));
  await release(write);
});
