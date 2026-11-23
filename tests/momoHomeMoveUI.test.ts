// MoMo's home surfaces in the renderer, the end of a move (src/components/momo/home): the way back the home offers, and no progress sheet once a move has finished or was cancelled.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  createElement,
  createFixtureSeam,
  createRoot,
  fixtureView,
  flush,
  MomoHomePage,
  NOW,
  resetMomoHomeStore,
  scenarioView,
  setMomoHomeSeam,
  window,
} from './support/momoHomeRig.ts';

async function mountView(v: ReturnType<typeof fixtureView>) {
  setMomoHomeSeam(createFixtureSeam(v, () => NOW));
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, { tab: 'chat', now: NOW })));
  await flush();
  const body = window.document.body as any;
  return {
    body,
    text: () => body.textContent as string,
    click: async (label: string) => {
      await act(async () => [...body.querySelectorAll('button')].find((b: any) => b.textContent.trim() === label).click());
      await flush();
    },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a move the home says can be reclaimed offers it, asks with the home’s own words, and sends the intent; one it does not offer it for does not', async () => {
  const stuck = await mountView(scenarioView('move-stuck'));
  assert.ok(stuck.text().includes('Moving MoMo to Mac mini'));
  assert.equal(
    [...stuck.body.querySelectorAll('button')].some((b: any) => b.textContent === 'Cancel'),
    false,
    'past the switch there is no Cancel, only the way back',
  );
  await stuck.click('Run MoMo here again');
  const sheet = stuck.body.querySelector('[role="alertdialog"]');
  assert.ok(sheet.textContent.includes('Run MoMo on Studio again?'));
  assert.ok(sheet.textContent.includes('The copy on Mac mini will be refused.'));
  await act(async () => [...sheet.querySelectorAll('button')].find((b: any) => b.textContent === 'Cancel').click());
  assert.equal(stuck.body.querySelector('[role="alertdialog"]'), null);
  await stuck.click('Run MoMo here again');
  await act(async () =>
    [...stuck.body.querySelectorAll('[role="alertdialog"] button')].find((b: any) => b.textContent === 'Run MoMo here again').click(),
  );
  await flush();
  assert.ok(stuck.text().includes('Runs on Studio'));
  assert.ok(!stuck.text().includes('Moving MoMo'));
  await stuck.close();
  const failed = scenarioView('move-failed');
  failed.home.move!.reclaim = { title: 'Run MoMo here again?', body: 'The copy on Mac mini will be refused.', confirm: 'Run it here' };
  const f = await mountView(failed);
  assert.ok(f.text().includes('Move didn’t finish'));
  assert.ok(f.text().includes('Run MoMo here again'));
  await f.close();
  const plain = await mountView(scenarioView('move-failed'));
  assert.ok(!plain.text().includes('Run MoMo here again'));
  await plain.close();
});

test('a move that finished or was cancelled draws no progress sheet; one that can still be reclaimed keeps a short card with the way back', async () => {
  for (const outcome of ['moved', 'cancelled'] as const) {
    const v = scenarioView('move-stuck');
    v.home.move = { ...v.home.move!, step: 'cleaning-up', outcome, finishedAt: 5, reclaim: null };
    const m = await mountView(v);
    assert.ok(!m.text().includes('Moving MoMo'), outcome);
    assert.ok(!m.text().includes('Cancel'), outcome);
    assert.ok(!m.text().includes('Run MoMo here again'), outcome);
    await m.close();
  }
  const kept = scenarioView('move-stuck');
  kept.home.move = { ...kept.home.move!, step: 'cleaning-up', outcome: 'moved', finishedAt: 5 };
  const k = await mountView(kept);
  assert.ok(!k.text().includes('Moving MoMo'));
  assert.ok(k.text().includes('Moved to Mac mini'));
  assert.ok(k.text().includes('Run MoMo here again'));
  await k.close();
});
