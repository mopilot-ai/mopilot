// A change the home told while the phone could not hear it is found by reading the home again when the connection is back and when the app comes to the front; and Cancel on a move says Cancelling… on the card at once.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot, flush, find, mount, tap, unmountAll, type Any } from './support/phone/momo-screens';

const hookPath = '../mobile/src/screens/momoPhone/useMomoHome';
const provPath = '../mobile/src/screens/momoPhone/HomeCacheProvider';
const fxPath = '../mobile/src/momoPhone/fixtures';
const { useMomoHome, forgetMomoHomeAnswers } = await import(hookPath);
const { HomeCacheContext } = await import(provPath);
const { fixtureView } = await import(fxPath);

afterEach(unmountAll);

test('the home is read again when the connection comes back and when the app comes to the front', async () => {
  forgetMomoHomeAnswers();
  const views: number[] = [];
  const access = {
    get: async () => null,
    mark: async () => undefined,
    stamps: async () => ({ view: () => true, push: () => true }),
    forgetScope: async () => undefined,
  };
  const runtime: Any = {
    snapshot: () => ({ user: { id: 'u1' }, selectedPair: 'p1', phase: 'online' }),
    request: async (method: string) => {
      if (method === 'machine.hello') return { capabilities: { momo: true, momoHome: true } };
      if (method === 'momo.home.view') return views.push(1), { view: fixtureView().view };
      throw new Error(method);
    },
    onEvent: () => () => undefined,
  };
  const out: Any = {};
  const Probe = ({ online }: { online: boolean }) => ((out.home = useMomoHome(runtime, online)), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = async (online: boolean) => {
    await act(async () => root.render(createElement(HomeCacheContext.Provider, { value: access }, createElement(Probe, { online }))));
    await flush();
    await flush();
  };
  await draw(true);
  assert.ok(out.home.store, 'the home is offered');
  assert.equal(views.length, 0, 'opening the hook reads nothing by itself');
  await draw(false);
  await draw(true);
  assert.equal(views.length, 1, 'back online: read again once');
  await act(async () => (globalThis as Any).__phoneForeground());
  await flush();
  assert.equal(views.length, 2, 'back in front: read again');
  await draw(true);
  assert.equal(views.length, 2, 'staying online reads nothing more');
  await act(async () => root.unmount());
  host.remove();
});

test('pressing Cancel on a move says Cancelling… on the card at once, and Cancel is not offered again', async () => {
  const m = await mount((v) => {
    Object.assign(v.home, { state: 'moving' });
    v.home.move = {
      moveId: 'm1',
      from: { machineId: 'studio', name: 'Studio' },
      to: { machineId: 'mini', name: 'Mac mini' },
      step: 'sealed',
      outcome: 'running',
      finishedAt: null,
      failure: null,
      oldMachineOffline: false,
      reclaim: null,
    };
  });
  m.transport.send = async () => ({ ok: true });
  await tap('Cancel');
  assert.match(m.text(), /Cancelling…/);
  assert.equal(find('Cancel')?.textContent, 'Cancelling…', 'the one button is the disabled Cancelling…');
  assert.equal(find('Cancelling…')?.getAttribute('aria-disabled'), 'true');
});
