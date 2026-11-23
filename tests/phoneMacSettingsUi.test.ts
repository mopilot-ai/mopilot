// The Mac's notification settings card: loads, cycles the mode, toggles kinds, titles and MoMo quiet hours, shows the Mac's refusals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot, flush, click, inputText, toggle } from './support/phone/component-kit';

const cardPath = '../mobile/src/push/MacNotificationSettings';
const macPath = '../mobile/src/push/macSettings';
const { MacNotificationSettings } = await import(cardPath);

const fresh = () => ({
  titlesInPush: false,
  mode: 'unfocused',
  kinds: {} as Record<string, boolean>,
  momoQuietHours: { start: '22:00', end: '07:00' } as null | { start: string; end: string },
  quietHours: null as null | { start: string; end: string },
});

function rig(over: { flag?: boolean; refuse?: string; hold?: Promise<void>; oldMac?: boolean; noMomo?: boolean } = {}) {
  const state: any = fresh();
  if (over.oldMac) delete state.quietHours;
  if (over.noMomo) delete state.momoQuietHours;
  const calls: Array<[string, any]> = [];
  const snap: any = { selectedPair: 'p', generation: 1 };
  const runtime: any = {
    snapshot: () => ({ ...snap }),
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      if (method === 'machine.hello')
        return { capabilities: over.flag === false ? {} : { pushSettings: true, ...(over.noMomo ? {} : { momo: true }) } };
      if (method === 'push.settings.get') return { ...state };
      await over.hold;
      if (over.refuse) throw new Error(over.refuse);
      if (params.mode) state.mode = params.mode;
      if (params.kinds) state.kinds = { ...state.kinds, ...params.kinds };
      if (params.titlesInPush !== undefined) state.titlesInPush = params.titlesInPush;
      if (params.momoQuietHours !== undefined) state.momoQuietHours = params.momoQuietHours;
      if (params.quietHours !== undefined) state.quietHours = params.quietHours;
      return { ...state };
    },
  };
  return { runtime, calls, snap, state };
}
async function mount(runtime: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MacNotificationSettings, { runtime })));
  await flush();
  return { host, unmount: async () => (await act(async () => root.unmount()), host.remove()) };
}
const sets = (calls: Array<[string, any]>) => calls.filter(([m]) => m === 'push.settings.set').map(([, p]) => p);

test('the card shows the Mac settings and every control saves one change', async () => {
  const r = rig();
  const view = await mount(r.runtime);
  assert.match(view.host.textContent!, /Notify: When away/);
  assert.equal(toggle('Finished chats'), 'On');
  await click('Notify: When away');
  await click('Notify: Always');
  await click('Finished chats');
  await click('Chat titles in notifications');
  await click('MoMo quiet hours');
  assert.deepEqual(sets(r.calls), [
    { mode: 'always' },
    { mode: 'needed' },
    { kinds: { turn: false } },
    { titlesInPush: true },
    { momoQuietHours: null },
  ]);
  assert.equal(toggle('Finished chats'), 'Off');
  assert.equal(toggle('Chat titles in notifications'), 'On');
  assert.equal(toggle('MoMo quiet hours'), 'Off');
  await click('MoMo quiet hours');
  assert.deepEqual(sets(r.calls).at(-1), { momoQuietHours: { start: '22:00', end: '07:00' } });
  await view.unmount();
});

test('quiet hours are saved with one button, only for two different valid times that differ from the Mac', async () => {
  const r = rig();
  const view = await mount(r.runtime);
  const save = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save MoMo quiet hours') as HTMLButtonElement;
  assert.equal(save().disabled, true, 'nothing changed yet');
  await inputText('MoMo quiet from (HH:MM)', '23');
  assert.equal(save().disabled, true, 'half-typed');
  await inputText('MoMo quiet from (HH:MM)', '07:00');
  assert.equal(save().disabled, true, 'same start and end');
  await inputText('MoMo quiet from (HH:MM)', '23:30');
  await inputText('MoMo quiet until (HH:MM)', '06:15');
  assert.deepEqual(sets(r.calls), [], 'typing sends nothing');
  await click('Save MoMo quiet hours');
  assert.deepEqual(sets(r.calls), [{ momoQuietHours: { start: '23:30', end: '06:15' } }]);
  assert.equal(save().disabled, true, 'saved: nothing left to save');
  await view.unmount();
});

test('text being typed survives another switch’s save, and the fields follow the Mac when its quiet hours change', async () => {
  const r = rig();
  const view = await mount(r.runtime);
  await inputText('MoMo quiet from (HH:MM)', '23:3');
  await click('Notify: When away');
  const from = () => (document.querySelector('input[placeholder="MoMo quiet from (HH:MM)"]') as HTMLInputElement).value;
  assert.equal(from(), '23:3');
  await click('MoMo quiet hours');
  await click('MoMo quiet hours');
  assert.equal(from(), '22:00', 'switched on again with the Mac’s own values');
  await view.unmount();
});

test('an account MoMo is not on for sees no MoMo kind and no MoMo quiet hours', async () => {
  const r = rig({ noMomo: true });
  const view = await mount(r.runtime);
  assert.match(view.host.textContent!, /Finished chats/);
  assert.doesNotMatch(view.host.textContent!, /MoMo/);
  await click('Chat titles in notifications');
  assert.deepEqual(sets(r.calls), [{ titlesInPush: true }]);
  await view.unmount();
  // an older Mac still sends the hours, but its hello says MoMo is off
  const old = rig({ noMomo: true });
  old.state.momoQuietHours = { start: '22:00', end: '07:00' };
  const v2 = await mount(old.runtime);
  assert.doesNotMatch(v2.host.textContent!, /MoMo/);
  await v2.unmount();
});

test('with notifications never, the kind switches are hidden', async () => {
  const r = rig();
  r.state.mode = 'never';
  const view = await mount(r.runtime);
  assert.match(view.host.textContent!, /Notify: Never/);
  assert.doesNotMatch(view.host.textContent!, /Finished chats/);
  await view.unmount();
});

test('an old Mac, a Mac refusal and a changed computer are shown as messages', async () => {
  const old = rig({ flag: false });
  const a = await mount(old.runtime);
  assert.match(a.host.textContent!, /Update MoPilot on your computer/);
  assert.doesNotMatch(a.host.textContent!, /Notify:/);
  assert.equal(a.host.querySelector('[role="alert"]'), null, 'an older computer is information, not an error');
  await a.unmount();
  const refusing = rig({ refuse: 'MoMo is not set up on this account.' });
  const b = await mount(refusing.runtime);
  await click('MoMo quiet hours');
  assert.match(b.host.textContent!, /MoMo is not set up/);
  assert.ok(b.host.querySelector('[role="alert"]'), 'a refusal is still an alert');
  assert.equal(toggle('MoMo quiet hours'), 'On', 'the shown setting stays what the Mac has');
  await b.unmount();
  const moved = rig();
  const c = await mount(moved.runtime);
  moved.snap.selectedPair = 'q';
  await click('Notify: When away');
  assert.match(c.host.textContent!, /connected computer changed/);
  await c.unmount();
});

test('a second tap while a save is in flight is ignored, and an unmount before the load settles is quiet', async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const r = rig({ hold });
  const view = await mount(r.runtime);
  const press = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Notify: When away')?.click();
  await act(async () => press());
  await act(async () => press());
  await inputText('MoMo quiet from (HH:MM)', '23:45');
  release();
  await flush();
  await flush();
  assert.equal(sets(r.calls).length, 1);
  await view.unmount();
  const late = rig();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MacNotificationSettings, { runtime: late.runtime })));
  await act(async () => root.unmount());
  await flush();
  host.remove();
});

test('an unmount before the load fails or succeeds leaves no state to update, and every kind has a label', async () => {
  const old = rig({ flag: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MacNotificationSettings, { runtime: old.runtime })));
  root.unmount();
  await flush();
  host.remove();
  const { KINDS } = await import(macPath);
  const { KIND_WORD } = await import(cardPath);
  assert.deepEqual(Object.keys(KIND_WORD).sort(), [...KINDS].sort());
});

test('a failed read of the settings is an alert, and nothing is drawn while it has neither failed nor answered', async () => {
  const failing = rig();
  const request = failing.runtime.request;
  failing.runtime.request = async (method: string, params: any) => {
    if (method === 'push.settings.get') throw new Error('Request timed out');
    return request(method, params);
  };
  const a = await mount(failing.runtime);
  assert.match(a.host.textContent!, /Request timed out/);
  assert.ok(a.host.querySelector('[role="alert"]'));
  await a.unmount();
  const pending = rig();
  pending.runtime.request = () => new Promise(() => {});
  const b = await mount(pending.runtime);
  assert.equal(b.host.textContent, '');
  await b.unmount();
});

test('the Mac’s quiet hours switch on with the usual times, are edited and saved apart from MoMo’s, and switch off', async () => {
  const r = rig();
  const view = await mount(r.runtime);
  assert.equal(toggle('Quiet hours'), 'Off');
  assert.match(view.host.textContent!, /A chat that needs you is sent once when they end/);
  await click('Quiet hours');
  assert.deepEqual(sets(r.calls).at(-1), { quietHours: { start: '22:00', end: '07:00' } });
  await inputText('Quiet from (HH:MM)', '23:15');
  await inputText('Quiet until (HH:MM)', '06:45');
  assert.deepEqual(sets(r.calls).length, 1, 'typing sends nothing');
  await click('Save quiet hours');
  assert.deepEqual(sets(r.calls).at(-1), { quietHours: { start: '23:15', end: '06:45' } });
  assert.equal(r.state.momoQuietHours!.start, '22:00', 'MoMo’s are untouched');
  await click('Quiet hours');
  assert.deepEqual(sets(r.calls).at(-1), { quietHours: null });
  assert.equal(toggle('Quiet hours'), 'Off');
  await view.unmount();
});

test('a Mac that has no quiet hours of its own shows no row for them', async () => {
  const r = rig({ oldMac: true });
  const view = await mount(r.runtime);
  assert.doesNotMatch(view.host.textContent!, /^.*Quiet hours: /);
  assert.equal(toggle('MoMo quiet hours'), 'On');
  await view.unmount();
});
