// What each of MoMo's flags gates on the Mac, for every combination of the Tasks panel (`momo.tasksPanel`, M0a) and suggestions (`momo.suggestions`, A7, its own flag): suggestions follow only their own flag, whatever the panel is, and the Tasks list follows only the panel; with both off MoMo is as it was. (The brief's flag, `momo.brief`, joins the table in tests/momoBriefFlags.test.ts with its own half.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const done = async (w: any) => {
  await w.m.close();
  require('../electron/momo/contract/context.cjs').setMomoContextProvider(null);
};
const suggestion = {
  title: 'Reply to Sam',
  why: 'He asked.',
  source: 'Mail: Sam',
  step: 'Draft a reply',
  from: 'mail',
  ref: 't1',
  kind: 'reply',
};
const combos = [false, true].flatMap((panel) => [false, true].map((sugg) => ({ panel, sugg })));

for (const { panel, sugg } of combos) {
  test(`Tasks panel ${panel ? 'on' : 'off'}, suggestions ${sugg ? 'on' : 'off'}: suggestions are there only with their own flag; the panel is what it was`, async () => {
    const w = world({ allowed: true, prefs: { momo: { brain: { main: { harness: 'claude' } }, tasksPanel: panel, suggestions: sugg } } });
    w.live.controller.state = { has: () => true, get: () => ({ turn: 'idle', queue: [], approvals: [] }) };
    const main = (await w.call('momoChat:mainChat')).value.chatId;
    const seg = w.chats.record(main).segments.at(-1);
    const tool = await w.live.capabilities.invoke(main, `${seg.kind}:${seg.nativeId}`, 'momo_suggest', suggestion);
    // the brain is offered the tool only with the suggestions flag
    assert.equal(tool.ok, sugg, 'momo_suggest');
    assert.equal(
      w.live.capabilities.list({ chatId: main }).some((t: any) => t.name === 'momo_suggest'),
      sugg,
      'listed for the brain',
    );
    const listed = await w.call('momoSuggestions:list');
    assert.equal(listed.ok, sugg, 'momoSuggestions:list');
    const acted = await w.call('momoSuggestions:act', 'x', 'hide');
    assert.equal(acted.ok, false);
    if (!sugg) {
      assert.deepEqual([listed.reason, listed.error], ['unavailable', 'Suggestions are off']);
      assert.equal(acted.reason, 'unavailable');
    }
    // the Tasks list is the panel's four tabs, or the classic list, by the panel flag alone
    assert.equal((await w.call('momoTasks:list')).v, panel ? 2 : undefined, 'momoTasks:list');
    await done(w);
  });
}

test('all flags off is MoMo as it was: no suggestion tool, none of its calls, the classic Tasks list', async () => {
  const w = world({ allowed: true, prefs: { momo: { brain: { main: { harness: 'claude' } } } } });
  const main = (await w.call('momoChat:mainChat')).value.chatId;
  assert.equal(
    w.live.capabilities.list({ chatId: main }).some((t: any) => t.name === 'momo_suggest'),
    false,
  );
  assert.equal((await w.call('momoSuggestions:list')).reason, 'unavailable');
  assert.equal((await w.call('momoTasks:list')).v, undefined);
  await done(w);
});
