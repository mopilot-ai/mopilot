// An older MoMo on the home page (src/components/momo/home/HomeBanner.tsx): a problem with its own ways on, each a button that runs its fix.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  createElement,
  createFixtureSeam,
  createRoot,
  flush,
  MomoHomePage,
  NOW,
  resetMomoHomeStore,
  scenarioView,
  setMomoHomeSeam,
  window,
} from './support/momoHomeRig.ts';

test('an older MoMo is a problem with its own ways on, each a button', async () => {
  const v: any = scenarioView('needs-update');
  v.problems = [
    {
      id: 'older:studio',
      code: 'older_home',
      cause: 'There is an older MoMo on Studio.',
      fix: { id: 'use-older:studio', label: 'Use the one on Studio' },
      also: [
        { id: 'keep-older:studio', label: 'Keep this one' },
        { id: 'delete-older:studio', label: 'Delete the old MoMo' },
      ],
      since: null,
    },
  ];
  setMomoHomeSeam(createFixtureSeam(v, () => NOW));
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, { tab: 'chat', now: NOW })));
  await flush();
  const labels = [...(window.document.body as any).querySelectorAll('button')].map((b: any) => b.textContent);
  for (const l of ['Use the one on Studio', 'Keep this one', 'Delete the old MoMo']) assert.ok(labels.includes(l), l);
  // a way on is its own button and runs its fix
  const keep = [...(window.document.body as any).querySelectorAll('button')].find((b: any) => b.textContent === 'Keep this one');
  await act(async () => keep.click());
  await flush();
  await act(async () => root.unmount());
  host.remove();
});
