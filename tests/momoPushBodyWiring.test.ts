// MoMo's opt-in push body in main (A6, electron/app/momoBackground.cjs over electron/momo/pushBody.cjs): the live resolver names the approved routine whose run raised a notice, only after the opt-in, and never for anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const { setMomoContextProvider } = require('../electron/momo/contract/context.cjs');

const momoChat = (w: any, id: string, meta: any) =>
  w.chats.commit({ id, segments: [{ kind: 'claude', nativeId: id, start: 0, count: null }], meta });
const done = async (w: any) => {
  await w.m.close();
  setMomoContextProvider(null);
};

test('the push body (A6): the live resolver names the approved routine whose run raised a notice, only after the opt-in, and never for anything else', async () => {
  const w = world({ allowed: true });
  const mine = await w.m.routineStore.add(
    { name: 'Morning brief', prompt: 'secret prompt', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    { approved: true },
  );
  const proposed = await w.m.routineStore.add(
    { name: 'Wire the money', prompt: 'p', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    { approved: false },
  );
  momoChat(w, 'run', { momo: 'routine', routineId: mine.id });
  momoChat(w, 'proposed-run', { momo: 'routine', routineId: proposed.id });
  momoChat(w, 'main', { momo: 'main' });
  // a run whose chat record is not written yet is matched by its open run
  await w.m.routineStore.beginRun({ chatId: 'fresh', taskId: mine.id, kind: 'momo-routine', due: 0 });
  const body = (chat: string) => w.live.momoPushBody(`momo:chat:${chat}`);
  // off by default
  assert.equal(w.live.momoPushBodyOn(), false);
  assert.equal(body('run'), '');
  w.prefs = { ...w.prefs, momo: { ...w.prefs.momo, notify: { pushBody: true } } };
  assert.equal(w.live.momoPushBodyOn(), true);
  assert.equal(body('run'), 'Morning brief');
  assert.equal(body('fresh'), 'Morning brief');
  for (const chat of ['proposed-run', 'main', 'nobody']) assert.equal(body(chat), '', chat);
  // the notice MoMo's routine run raised is the one that names it: through the quiet hook, as an approval waiting is
  w.live.notifier.quiet('approval', 'run');
  assert.equal(w.live.notifier.shown.at(-1)[1], 'momo:chat:run');
  assert.equal(JSON.stringify(w.live.notifier.shown.at(-1)).includes('Morning brief'), false, 'the banner itself carries no name');
  // MoMo turned off for the account: none
  w.allowed = false;
  assert.equal(w.live.momoPushBodyOn(), false);
  assert.equal(body('run'), '');
  await done(w);
});
