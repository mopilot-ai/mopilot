// A quiet-sender rule through the REAL notice and learning services (momoHomeFor loads both): two taps make the suggestion, Accept turns it on, and then what the rule keeps out, what it never does, what it counts, where it is shown, and how it is undone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailOf, world } from './support/host/noticeHomeWorld.ts';

const at = (n: number) => new Date(Date.now() + n * 1000).toISOString();

/** A home whose owner has accepted a quiet rule for acme.com, made the real way: two Not needed taps, then Accept. */
async function quietWorld(t: any) {
  const w = await world(t, 'tell_now');
  const learning = w.home.service('learning');
  const run = async (intent: object) => (w.home.intentRegistry().intents() as any)[(intent as any).kind](intent);
  // the owner has written to acme.com before: it is a known correspondent, so money and credentials mail from it is not "may not be from"
  w.threads.s0 = mailOf('s0', 'Re: hello', 'Thanks.', { date: at(0), from: 'Maya <maya@x.com>', to: ['ana@acme.com'], labels: ['SENT'] });
  w.threads.t0 = mailOf('t0', 'Hello', 'Welcome.', { date: at(0) });
  w.answers.push(w.answer('quiet'));
  await w.notice().tick();
  let n = 0;
  const next = async (id: string, body: string, verdict = 'tell_now', over: object = {}) => {
    w.threads[id] = mailOf(id, `Subject ${id}`, body, { date: at(++n), ...over });
    w.answers.push(w.answer(verdict, 'A promo.'));
    return w.notice().tick();
  };
  for (const id of ['t1', 't2']) {
    await next(id, 'A big sale on shoes.');
    const [seen] = await w.notice().decisions({ ids: [`gmail:${id}`] });
    await run({ kind: 'row.notNeeded', rowId: `gmail:${id}`, decisionId: seen.decisionId });
  }
  await learning.confirm(learning.view().rules[0].id, 'phone:a');
  assert.equal(learning.quietSenders().length, 1);
  w.told.length = 0;
  const decision = async (id: string) => (await w.notice().decisions({ ids: [`gmail:${id}`] })).at(-1);
  return { w, learning, next, decision, run };
}

test('exemptions through the real service: money, risk wording alone, a deadline and urgency today are told despite the rule', async (t) => {
  const q = await quietWorld(t);
  for (const [id, body] of [
    ['m1', 'Your invoice is due, please pay by wire transfer.'],
    ['m2', 'Your shop has been paused until you act.'],
    ['m3', 'Please confirm by 2099-01-01.'],
    ['m4', 'Your account closes today.'],
  ] as const) {
    await q.next(id, body);
    const d = await q.decision(id);
    assert.equal(d.outcome, 'tell_now', body);
    assert.match(d.reason, /^Told you despite your quiet rule for acme\.com: /, body);
  }
  assert.equal(q.w.told.length, 4);
  await q.next('p1', 'Another big sale on boots.');
  assert.equal((await q.decision('p1')).outcome, 'quiet');
  assert.equal(q.w.told.length, 4, 'the plain promo is kept out');
});

test('a tell-me-now rule that names the domain beats the quiet rule, written the way an owner writes it; one that does not name it does not', async (t) => {
  const q = await quietWorld(t);
  assert.ok(await q.learning.add('Landlord mail is urgent', 'tell_now', 'phone:a'));
  await q.next('p1', 'A big sale on socks.');
  assert.equal((await q.decision('p1')).outcome, 'quiet', 'a rule that names no sender changes nothing');
  assert.ok(await q.learning.add('Always tell me about mail from Acme.COM.', 'tell_now', 'phone:a'));
  await q.next('p2', 'A big sale on hats.');
  assert.equal((await q.decision('p2')).outcome, 'tell_now');
  assert.equal(q.w.told.length, 1);
});

test('a rule-held mail is listed once: in "Kept quiet by your rules", not in Needs you and not in Left out; the brief shows it and Undo from the card reaches the rule', async (t) => {
  const q = await quietWorld(t);
  await q.next('p1', 'A big sale on socks.');
  const built = await q.w.notice().seams.build({
    day: '2026-11-24',
    since: 0,
    until: Date.now() + 60_000,
    zone: 'UTC',
    stamp: q.w.home.stamp(),
  });
  assert.deepEqual(
    built.view.keptQuiet.map((k: any) => k.id),
    ['gmail:p1'],
  );
  assert.equal(
    built.brief.needsYou.some((m: any) => m.matterKey === 'gmail:p1'),
    false,
  );
  assert.equal(
    built.view.leftOut.some((l: any) => l.id === 'gmail:p1'),
    false,
  );
  assert.match(built.text, /Kept quiet by your rules:\n- Subject p1 \(your rule for acme\.com\)/);
  // Undo from the card: its rule id is the real rule
  const ruleId = built.view.keptQuiet[0].ruleId;
  assert.ok(await q.learning.undo(ruleId, 'phone:a'));
  assert.deepEqual(q.learning.quietSenders(), []);
  await q.next('p2', 'A big sale on hats.');
  assert.equal((await q.decision('p2')).outcome, 'tell_now');
});

test('Undo from the decision row reaches the real rule, and the rule is counted as used only when it held a mail', async (t) => {
  const q = await quietWorld(t);
  const used: string[] = [];
  const real = q.learning.used.bind(q.learning);
  q.learning.used = async (id: string) => (used.push(id), real(id));
  await q.next('p1', 'A big sale on socks.');
  const d = await q.decision('p1');
  assert.deepEqual(used, [d.rule.id]);
  // a mail held for another reason is not labelled and not counted: the matter is dismissed, so nothing is held by the rule
  const run = q.run;
  await q.next('p2', 'A big sale on hats.', 'tell_now', { id: 'm-p2' });
  await run({ kind: 'row.notNeeded', rowId: 'gmail:p2', decisionId: (await q.decision('p2')).decisionId });
  used.length = 0;
  q.w.threads.p2 = mailOf('p2', 'Subject p2', 'Another reply on hats.', { id: 'm-p2-2', date: at(50) });
  q.w.answers.push(q.w.answer('tell_now', 'A promo.'));
  await q.w.notice().tick();
  const after = await q.decision('p2');
  assert.equal(after.rule, null, 'a dismissed matter is held by the dismissal, not by the rule');
  assert.doesNotMatch(after.reason, /Kept quiet by your rule/);
  assert.deepEqual(used, []);
  // Undo from the row
  assert.ok(await q.learning.undo(d.rule.id, 'phone:a'));
  assert.deepEqual(q.learning.quietSenders(), []);
});

test('with the brief off, a rule-held mail waits in Watching and says why instead of waiting for a brief nobody gets', async (t) => {
  const q = await quietWorld(t);
  await q.w.home.prefs.change({ brief: { on: false } });
  await q.next('p1', 'A big sale on socks.');
  const matter = (await q.w.notice().watching()).find((m: any) => m.title === 'Subject p1');
  assert.ok(matter, 'the held mail is in Watching');
  assert.match(matter.step, /^Kept quiet by your rule for acme\.com/);
  const d = await q.decision('p1');
  assert.ok(d.checks.includes('Held in Watching (your brief is off): kept quiet by your rule for this sender.'));
  assert.deepEqual(q.w.told, []);
});
