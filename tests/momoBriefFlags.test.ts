// What each of MoMo's three flags gates on the Mac, for all eight combinations of the Tasks panel (`momo.tasksPanel`), suggestions (`momo.suggestions`) and the brief (`momo.brief`): the brief's task, its Scheduled row (which also needs the panel's four tabs) and Try again need only `brief`; suggestions (their tool, their calls) need only `suggestions`; the panel's list needs only the panel. With all three off MoMo is as it was. (What the brief itself holds, by the suggestions flag, is tested with its inputs in tests/momoBriefWiring.test.ts.)
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const done = async (w: any) => {
  await w.m.close();
  require('../electron/momo/contract/context.cjs').setMomoContextProvider(null);
};
const flags = [false, true].flatMap((panel) =>
  [false, true].flatMap((suggestions) => [false, true].map((brief) => ({ panel, suggestions, brief }))),
);
const name = (f: { panel: boolean; suggestions: boolean; brief: boolean }) =>
  `Tasks panel ${f.panel ? 'on' : 'off'}, suggestions ${f.suggestions ? 'on' : 'off'}, brief ${f.brief ? 'on' : 'off'}`;

for (const f of flags) {
  test(`${f.panel || f.suggestions || f.brief ? name(f) : 'all three off, MoMo as it was'}: each flag gates only its own part`, async () => {
    const w = world({
      allowed: true,
      prefs: {
        momo: {
          brain: { main: { harness: 'claude' } },
          tasksPanel: f.panel,
          suggestions: f.suggestions,
          brief: f.brief,
          routines: { quietHours: null },
        },
      },
    });
    w.live.controller.state = { has: () => true, get: () => ({ turn: 'idle', queue: [], approvals: [] }) };
    const main = (await w.call('momoChat:mainChat')).value.chatId;
    // suggestions: the tool offered to the brain, and the calls
    assert.equal(
      w.live.capabilities.list({ chatId: main }).some((t: any) => t.name === 'momo_suggest'),
      f.suggestions,
      'momo_suggest listed',
    );
    assert.equal((await w.call('momoSuggestions:list')).ok, f.suggestions, 'suggestions list');
    // the panel: four tabs or the classic list
    const list = await w.call('momoTasks:list');
    assert.equal(list.v, f.panel ? 2 : undefined, 'the Tasks list');
    // the brief: its scheduler task, its Scheduled row (in the panel's list) and Try again
    assert.equal(
      w.m.routines.tasks().some((t: any) => t.id === 'momo.brief'),
      f.brief,
      'the brief’s task',
    );
    assert.equal(
      (list.tasks ?? []).some((t: any) => t.kind === 'brief'),
      f.panel && f.brief,
      'the brief’s row',
    );
    const tried = await w.call('momoBrief:runNow');
    assert.equal(tried.reason === 'unavailable', !f.brief, 'Try again');
    await done(w);
  });
}
