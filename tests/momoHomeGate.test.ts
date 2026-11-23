// When MoMo's home surfaces are used (src/components/momo/home/homeSeam.ts, useMomoHome.ts): never without a bridge that has a home; fixtures only in a dev run that names them (never "0", never in a packaged build); otherwise the IPC seam, and the surfaces replace the current pages only once the home has answered with a view.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, window } from './support/momoHomeRig.ts';
import { native } from '../src/lib/native.ts';
import { momoHomeSeam, setMomoHomeSeam } from '../src/components/momo/home/homeSeam.ts';
import { resetMomoHomeStore, useMomoHomeStatus, useMomoAct } from '../src/components/momo/home/useMomoHome.ts';
import { fixtureView } from '../src/components/momo/home/homeFixtures.ts';

const store = (globalThis as any).localStorage;
const withBridge = (b: unknown) => ((native as any).momoHome = b);
const bridge = (o: { dev?: boolean | (() => Promise<boolean>); view?: () => Promise<unknown> } = {}) => ({
  view: o.view ?? (async () => ({ ok: true, view: fixtureView() })),
  intent: async () => ({ ok: true }),
  onChanged: () => () => undefined,
  dev: typeof o.dev === 'function' ? o.dev : async () => o.dev === true,
  devScenario: async () => false,
});
const fresh = () => (setMomoHomeSeam(null), resetMomoHomeStore());
const views = async (seam: any) => (await seam.read()).view;

test('without a home on the bridge there is no seam, so the page is today’s', async () => {
  fresh();
  withBridge(undefined);
  assert.equal(await momoHomeSeam(), null);
});

test('a dev run draws fixtures only when it names them, the served home only for "ipc", and nothing otherwise; a packaged build gets the IPC seam', async () => {
  const fx = fixtureView();
  const isFixture = async (seam: any) => (await views(seam)).home.sources.length === fx.home.sources.length && seam.script !== undefined;
  for (const [dev, value, fixtures] of [
    [true, '1', true],
    [true, 'asleep', true],
    [true, 'ipc', false],
    [true, '0', 'none'],
    [true, '', 'none'],
    [true, null, 'none'],
    [false, '1', false],
    [false, 'asleep', false],
  ] as const) {
    fresh();
    value === null ? store.removeItem('momo.homeUi') : store.setItem('momo.homeUi', value);
    withBridge(bridge({ dev }));
    const seam: any = await momoHomeSeam();
    if (fixtures === 'none') {
      assert.equal(seam, null, `dev ${dev} switch ${JSON.stringify(value)} leaves today's pages`);
      store.removeItem('momo.homeUi');
      continue;
    }
    assert.equal('script' in seam, fixtures, `dev ${dev} switch ${JSON.stringify(value)}`);
    if (fixtures) assert.equal(await isFixture(seam), true);
    store.removeItem('momo.homeUi');
  }
  fresh();
  withBridge(bridge({ dev: () => Promise.reject(new Error('x')) }));
  store.setItem('momo.homeUi', '1');
  assert.equal('script' in ((await momoHomeSeam()) as any), false, 'a bridge that cannot say is not a dev run, so it gets the IPC seam');
  store.removeItem('momo.homeUi');
  withBridge(undefined);
});

function Probe({ seen }: { seen: string[] }) {
  seen.push(useMomoHomeStatus().status);
  return null;
}
const mountProbe = async () => {
  const seen: string[] = [];
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(Probe, { seen })));
  await flush();
  return { seen, close: () => act(async () => root.unmount()) };
};

test('the store is ready once the home answers a view, and unavailable with the home’s words when it does not or there is no bridge', async () => {
  fresh();
  withBridge(bridge());
  const ok = await mountProbe();
  assert.equal(ok.seen.at(-1), 'ready');
  assert.equal(ok.seen[0], 'loading');
  await ok.close();
  fresh();
  withBridge(bridge({ view: async () => ({ ok: false, cause: 'MoMo’s home isn’t available here yet.' }) }));
  const no = await mountProbe();
  assert.equal(no.seen.at(-1), 'unavailable');
  await no.close();
  fresh();
  withBridge(undefined);
  const none = await mountProbe();
  assert.equal(none.seen.at(-1), 'unavailable');
  await none.close();
  // a screen that left before the answer arrived is not told
  fresh();
  let answer: (v: unknown) => void = () => undefined;
  withBridge(bridge({ view: () => new Promise((r) => (answer = r)) }));
  const early = await mountProbe();
  await early.close();
  answer({ ok: true, view: fixtureView() });
  await flush();
  assert.equal(early.seen.at(-1), 'loading');
  withBridge(undefined);
});

test('a move with no seam is refused in words, and a seam that throws is too', async () => {
  fresh();
  withBridge(undefined);
  let run: any;
  function Mover() {
    run = useMomoAct().act;
    return null;
  }
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(Mover)));
  assert.deepEqual(await run({ type: 'home.wake' }), { ok: false, cause: 'MoMo’s home isn’t available here.' });
  setMomoHomeSeam({
    read: async () => ({ ok: false, cause: 'x' }),
    subscribe: () => () => undefined,
    act: () => Promise.reject(new Error('x')),
  });
  assert.deepEqual(await run({ type: 'home.wake' }), { ok: false, cause: 'MoMo’s home didn’t answer.' });
  await act(async () => root.unmount());
  setMomoHomeSeam(null);
});

test('a screen that is gone before the seam is chosen is not told what it chose', async () => {
  fresh();
  let chose: (dev: boolean) => void = () => undefined;
  withBridge(bridge({ dev: () => new Promise<boolean>((r) => (chose = r)) }));
  const early = await mountProbe();
  await early.close();
  chose(false);
  await flush();
  assert.deepEqual(early.seen, ['loading']);
  withBridge(undefined);
});
