// The owner's standing rules reach the notice judge (host/src/momoNotice.mjs, shared/momoNotice/reading.ts): in their own words outside the data envelope, only the kinds that decide tell-now versus quiet, and the learning service hears once that they were applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingPrompt, ruleLines } from '../shared/momoNotice/reading.ts';
import { answer, mail, minutes, rig } from './support/host/momoNoticeRig.ts';

const rule = (id: string, kind: string, text: string) => ({ id, kind, text });

test('ruleLines keeps the three judged kinds, drops ask_first and empty text, cleans and cuts each rule', () => {
  assert.deepEqual(ruleLines(undefined), []);
  const lines = ruleLines([
    rule('a', 'tell_now', 'Tell me about the landlord'),
    rule('b', 'stay_quiet', 'Never\u0000 the\nnewsletter'),
    rule('c', 'ask_first', 'Ask before sending'),
    rule('d', 'instruction', 'x'.repeat(400)),
    rule('e', 'tell_now', '   '),
    rule('f', 'toString', 'inherited name'),
  ] as any);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '- Tell them now: Tell me about the landlord');
  assert.ok(lines[1]!.startsWith('- Keep quiet: ') && !lines[1]!.includes('\u0000') && !lines[1]!.includes('\n'));
  assert.ok(lines[2]!.startsWith('- Instruction: ') && lines[2]!.length < 330);
  assert.equal(ruleLines(Array.from({ length: 150 }, (_, i) => rule(`r${i}`, 'tell_now', 'x')) as any).length, 100);
});

test('the prompt carries the rules as the owner’s own text, before the answer format and the item, and says what they cannot change', () => {
  const item = { kind: 'mail', mail: mail('t1') } as any;
  const person = { name: 'Maya', email: 'maya@x.com', rules: [rule('a', 'tell_now', 'Landlord mail is urgent')] } as any;
  const text = readingPrompt(item, person, new Date('2026-11-24T12:00:00Z'), () => 'rid');
  assert.ok(text.indexOf('Landlord mail is urgent') < text.indexOf('Answer with one JSON object'));
  assert.ok(text.indexOf('Landlord mail is urgent') < text.indexOf('<<<EXTERNAL_UNTRUSTED_CONTENT'));
  assert.ok(/quiet hours, the daily cap or any safety check/.test(text));
  assert.ok(!readingPrompt(item, { ...person, rules: [rule('c', 'ask_first', 'q')] }, new Date(), () => 'rid').includes('standing rules'));
});

test('a pass hands the judge the rules and tells the learning service once; none judged means no call', async (t) => {
  const applied: string[] = [];
  const w = rig(t);
  w.state.learning = { ownerRules: () => [rule('a', 'stay_quiet', 'Ignore the gym')], appliedBy: (s: string) => applied.push(s) };
  await w.notice.tick();
  w.clock.at += minutes(10);
  w.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  w.world.threads.t2 = mail('t2', { date: '2026-11-24T12:06:00Z' });
  w.answers.push(answer('quiet'), answer('quiet'));
  await w.notice.tick();
  assert.equal(w.prompts.length, 2);
  assert.ok(w.prompts.every((p) => p.includes('- Keep quiet: Ignore the gym')));
  assert.deepEqual(applied, ['notice']);

  const only = rig(t);
  only.state.learning = { ownerRules: () => [rule('q', 'ask_first', 'ask')], appliedBy: () => assert.fail('no judged rule') };
  await only.notice.tick();
  only.clock.at += minutes(10);
  only.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  only.answers.push(answer('quiet'));
  await only.notice.tick();
  assert.equal(only.prompts.length, 1);
});

test('no learning service, a non-list answer, or a throwing service leaves the judge without rules and a pass still runs', async (t) => {
  for (const learning of [
    undefined,
    { ownerRules: () => 'nope' },
    {
      ownerRules: () => {
        throw new Error('boom');
      },
    },
  ] as any[]) {
    const w = rig(t);
    w.state.learning = learning;
    await w.notice.tick();
    w.clock.at += minutes(10);
    w.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
    w.answers.push(answer('quiet'));
    await w.notice.tick();
    assert.equal(w.prompts.length, 1);
    assert.ok(!w.prompts[0]!.includes('standing rules'));
    if (learning?.ownerRules?.toString().includes('boom')) assert.ok(w.reports.some((r) => r.includes("owner's rules")));
  }
});
