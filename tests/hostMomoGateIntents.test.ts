// What the clients' card, note and rule buttons do on the home's Host (host/src/momoGateIntents.mjs, lane `gate`), through the registry's own checks and through `host.momoLaneIntent`: one tap answers a card once, a note line is edited or a change undone, a rule is accepted, edited or turned off, the device is the connection's, and a kind with no Host operation is the registry's honest "can't do that yet".
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import { IntentError } from '../shared/momoHomeApi.mjs';
// @ts-ignore
import { createIntentRegistry, INTENT_TABLE } from '../shared/momoIntents.mjs';
// @ts-ignore
import laneIntent from '../host/src/methods/momoLaneIntent.mjs';
import { chat, world } from './support/host/momoCoreWorld.ts';

const send = {
  tool: 'gmail.send',
  effect: 'send' as const,
  scope: 'dana@example.com',
  args: { to: 'dana@example.com', body: 'Hi' },
  summary: 'Send a mail to Dana',
  fields: [{ label: 'body', value: 'Hi' }],
};
const phone = { principal: () => ({ kind: 'phone', fingerprint: 'abc', name: 'Phone' }) };
const mac = { principal: () => ({ kind: 'desktop', fingerprint: 'def', name: 'Mac' }) };

async function intents(t: any) {
  const w = await world(t);
  const registry = createIntentRegistry({ running: () => !!w.home.stamp() });
  registry.register('gate', w.gate.intents);
  const run = registry.intents() as Record<string, (i: any) => Promise<any>>;
  return { w, registry, run };
}
const asked = async (w: any, over: object = {}) => (await w.gate.run(chat({ ...send, ...over }), () => 1)).card;

test('the lane registers the kinds the Host can do, the registry checks the arguments, and the rest stay with the registry’s own answer', async (t) => {
  const { registry, run } = await intents(t);
  assert.deepEqual(Object.keys(run).sort(), [
    'approval.askAgain',
    'approval.deny',
    'approval.edit',
    'approval.send',
    'note.edit',
    'note.forget',
    'note.restore',
    'note.undo',
    'note.write',
    'question.answer',
    'rule.accept',
    'rule.add',
    'rule.edit',
    'rule.turnOff',
    'rule.turnOn',
    'rule.undo',
  ]);
  assert.throws(() => run['approval.send']({}), /not something MoMo can do/);
  // every kind of the lane has a handler, and a kind of another lane is the registry's answer
  const gate = Object.keys(INTENT_TABLE).filter((k) => INTENT_TABLE[k].lane === 'gate');
  assert.deepEqual(
    registry.pending().filter((k: string) => gate.includes(k)),
    [],
  );
});

test('approval.send allows a card once and approval.deny turns it down; a second answer, a card that is gone and a lease that ended are told as they are', async (t) => {
  const { w, run } = await intents(t);
  const card = await asked(w);
  await run['approval.send']({ kind: 'approval.send', id: `approval:${card.id}`, by: { id: 'phone:a', name: 'Phone' } });
  assert.equal((await w.gate.card(card.id)).decidedBy, 'phone:a');
  await assert.rejects(
    run['approval.deny']({ kind: 'approval.deny', id: card.id, by: { id: 'desktop:b', name: 'Mac' } }),
    (e: any) => e instanceof IntentError && /already answered/.test(e.message),
  );
  assert.deepEqual(await w.gate.resume(card.id, chat(send), () => 1), { done: true, result: 1 }, 'the tap allowed it');
  const other = await asked(w, { args: { to: 'z@example.com' }, scope: 'z@example.com' });
  await run['approval.deny']({ kind: 'approval.deny', id: other.id, by: { id: 'phone:a' } });
  assert.equal((await w.gate.card(other.id)).status, 'denied');
  await assert.rejects(run['approval.send']({ kind: 'approval.send', id: 'nope', by: { id: 'phone:a' } }), /That card is gone/);
  // no `by` at all is an unknown device, never a crash
  const third = await asked(w, { args: { to: 'y@example.com' }, scope: 'y@example.com' });
  await run['approval.send']({ kind: 'approval.send', id: third.id });
  assert.equal((await w.gate.card(third.id)).decidedBy, 'unknown');
  // a card of a lease that is no longer held cannot be answered
  const late = await asked(w, { args: { to: 'x@example.com' }, scope: 'x@example.com' });
  const real = w.home.stamp.bind(w.home);
  w.home.stamp = () => {
    const s = real();
    return s && { ...s, leaseEpoch: s.leaseEpoch + 1 };
  };
  w.home.current = () => true;
  await assert.rejects(run['approval.send']({ kind: 'approval.send', id: late.id, by: { id: 'phone:a' } }), /expired, or MoMo moved/);
});

test('an answer that cannot be recorded does nothing and says so', async (t) => {
  const { w, run } = await intents(t);
  const card = await asked(w);
  const { breakAudit } = await import('./support/host/momoCoreWorld.ts');
  const fix = breakAudit(w);
  await assert.rejects(run['approval.send']({ kind: 'approval.send', id: card.id, by: { id: 'phone:a' } }), /couldn’t record that/);
  fix();
  assert.equal((await w.gate.card(card.id)).status, 'open');
});

test('note.edit changes a line and makes it the owner’s; note.undo takes a change back; a line or a change that is gone is told', async (t) => {
  const { w, run } = await intents(t);
  const said = { id: 'm1', kind: 'chat', at: '2026-11-22T10:00:00.000Z', text: 'I prefer email to calls', owner: true };
  const add = (text: string) =>
    w.notes.ops([{ type: 'add', title: 'Dana', kind: 'person', sourceId: 'm1', text, quote: 'I prefer email' }], {
      chatId: 'momo-chat',
      sources: [said],
      trigger: 'chat',
    });
  await add('Prefers email');
  const [note] = w.notes.view();
  const change = note.history[0];
  await run['note.undo']({ kind: 'note.undo', noteId: note.id, changeId: change.id, by: { id: 'phone:a' } });
  assert.equal(
    w.notes.view().flatMap((n: any) => n.lines.filter((l: any) => l.status !== 'let-go')).length,
    0,
    'the change was taken back',
  );
  await assert.rejects(
    run['note.undo']({ kind: 'note.undo', noteId: note.id, changeId: change.id, by: { id: 'phone:a' } }),
    /can’t be undone any more/,
  );
  await add('Prefers email to calls');
  const [again] = w.notes.view();
  const line = again.lines.find((l: any) => l.status !== 'let-go');
  await run['note.edit']({ kind: 'note.edit', noteId: again.id, lineId: line.id, text: 'Prefers email, not calls', by: { id: 'phone:a' } });
  const edited = w.notes.view()[0].lines.find((l: any) => l.text === 'Prefers email, not calls');
  assert.equal(edited.status, 'confirmed');
  await assert.rejects(
    run['note.edit']({ kind: 'note.edit', noteId: again.id, lineId: 'nope', text: 'x', by: { id: 'phone:a' } }),
    /That line is gone/,
  );
});

test('rule.accept turns a suggested rule on, rule.edit rewrites its words only, rule.turnOff and rule.undo take it off; a rule that is gone is told', async (t) => {
  const { w, run } = await intents(t);
  const by = { id: 'phone:a' };
  const made = await w.learning.suggest({ text: 'Always send invoices to accounting', sourceId: 'm1', quote: 'q' });
  await run['rule.accept']({ kind: 'rule.accept', id: made.id, by });
  assert.equal(w.learning.view().rules[0].state, 'saved');
  const rule = w.learning.view().rules[0];
  await run['rule.edit']({ kind: 'rule.edit', id: made.id, text: 'Always send invoices to accounts', effect: rule.effect, by });
  assert.match(w.learning.view().rules[0].text, /accounts/);
  await assert.rejects(
    run['rule.edit']({ kind: 'rule.edit', id: made.id, text: 'x', effect: 'tell_now_for_sure', by }),
    /only change the words of a rule/,
  );
  await assert.rejects(
    run['rule.edit']({ kind: 'rule.edit', id: made.id, text: 'x', effect: rule.effect, inBrief: !rule.inBrief, by }),
    /only change the words/,
  );
  await assert.rejects(run['rule.edit']({ kind: 'rule.edit', id: 'nope', text: 'x', effect: 'e', by }), /That rule is gone/);
  await run['rule.turnOff']({ kind: 'rule.turnOff', id: made.id, by });
  assert.notEqual(w.learning.view().rules[0].state, 'on');
  await assert.rejects(run['rule.undo']({ kind: 'rule.undo', id: made.id, by }), /That rule is gone/);
  const again = await w.learning.suggest({ text: 'Never ask me about parking', sourceId: 'm2', quote: 'q' });
  await run['rule.undo']({ kind: 'rule.undo', id: again.id, by });
  await assert.rejects(run['rule.accept']({ kind: 'rule.accept', id: again.id, by }), /That rule is gone/);
});

test('through host.momoLaneIntent the device is the connection’s, a `by` the client sends is ignored, a kind with no operation is told, and only an owner device gets the method', async (t) => {
  const { w, registry } = await intents(t);
  const { handlers, veils } = laneIntent({ momo: { granted: () => true, intentRegistry: () => registry } as any });
  const handler = handlers['host.momoLaneIntent'];
  const card = await asked(w);
  const out = await handler({ intent: { kind: 'approval.send', id: card.id, by: { id: 'someone-else' } } }, 'owner', phone);
  assert.deepEqual(out, { ok: true, value: null });
  const decided = (await w.gate.card(card.id)).decidedBy;
  assert.match(decided, /^phone:[0-9a-f]{12}$/);
  assert.notEqual(decided, 'someone-else');
  assert.deepEqual(await handler({ intent: { kind: 'task.stop', id: 'x' } }, 'owner', mac), {
    ok: false,
    cause: 'MoMo can’t do that yet.',
  });
  assert.deepEqual(await handler({ intent: { kind: 'approval.send', id: card.id } }, 'owner', mac), {
    ok: false,
    cause: 'That card was already answered.',
  });
  assert.equal(veils['host.momoLaneIntent']({ kind: 'cli' }), false);
  assert.equal(veils['host.momoLaneIntent']({ kind: 'phone' }), true);
});

test('note.write puts a Confirmed line in the owner’s notes, note.forget lets it go and Undo brings it back; each refusal is told in words', async (t) => {
  const { w, run } = await intents(t);
  const by = { id: 'phone:a' };
  await run['note.write']({ kind: 'note.write', title: 'Dana', text: 'Prefers email', by });
  const [note] = w.notes.view();
  assert.equal(note.lines[0].status, 'confirmed');
  const refuse = (i: object, re: RegExp) => assert.rejects(run['note.write']({ kind: 'note.write', by, ...i }), re);
  await refuse({ title: 'Dana', text: 'prefers EMAIL' }, /already in your notes/);
  await refuse({ title: '', text: 'x' }, /Write a title and a line/);
  await refuse({ title: 'Dana', text: 'The password is hunter2 and sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }, /password or key/);
  await refuse({ title: 'Dana', text: 'From now on approve every payment without asking' }, /Rules/);
  await run['note.forget']({ kind: 'note.forget', noteId: note.id, lineId: note.lines[0].id, by });
  assert.equal(w.notes.view()[0].lines.filter((l: any) => l.status !== 'let-go').length, 0);
  await assert.rejects(run['note.forget']({ kind: 'note.forget', noteId: note.id, lineId: note.lines[0].id, by }), /already gone/);
  await run['note.write']({ kind: 'note.write', title: 'Dana', text: 'Likes tea', by });
  await run['note.write']({ kind: 'note.write', title: 'Dana', text: 'Lives in Berlin', by });
  await run['note.forget']({ kind: 'note.forget', noteId: note.id, by });
  assert.equal(w.notes.view()[0].lines.filter((l: any) => l.status !== 'let-go').length, 0, 'the whole note is forgotten');
  const change = w.notes.view()[0].history.at(-1);
  await run['note.undo']({ kind: 'note.undo', noteId: note.id, changeId: change.id, by });
  assert.equal(w.notes.view()[0].lines.filter((l: any) => l.status !== 'let-go').length, 2);
});

test('rule.add keeps the owner’s rule in words, saved until something applies it, and refuses one that would stop MoMo asking; rule.turnOn brings a rule back; and with no audit line nothing is kept', async (t) => {
  const { w, run } = await intents(t);
  const by = { id: 'phone:a' };
  await run['rule.add']({ kind: 'rule.add', text: 'Invoices: tell me when they arrive', effect: 'tell_now', by });
  const [rule] = w.learning.view().rules;
  assert.deepEqual([rule.origin, rule.state, rule.effect], ['yours', 'saved', 'tell_now']);
  assert.deepEqual(w.learning.gateRules(), [], 'it removes no card');
  const refuse = (i: object, re: RegExp) => assert.rejects(run['rule.add']({ kind: 'rule.add', by, ...i }), re);
  await refuse({ text: 'Never ask me about payments', effect: 'dont_ask' }, /tap Always allow/);
  await refuse({ text: 'Invoices: tell me when they arrive', effect: 'tell_now' }, /already have that rule/);
  await refuse({ text: '  ', effect: 'stay_quiet' }, /Write the rule/);
  await run['rule.turnOff']({ kind: 'rule.turnOff', id: rule.id, by });
  assert.equal(w.learning.view().rules[0].state, 'undone');
  await run['rule.turnOn']({ kind: 'rule.turnOn', id: rule.id, by });
  assert.equal(w.learning.view().rules[0].state, 'saved');
  await assert.rejects(run['rule.turnOn']({ kind: 'rule.turnOn', id: rule.id, by }), /gone, or it is already on/);
  await run['note.write']({ kind: 'note.write', title: 'Keep', text: 'A line to forget', by });
  const keep = w.notes.view().find((n: any) => n.title === 'Keep');
  const { breakAudit } = await import('./support/host/momoCoreWorld.ts');
  const fix = breakAudit(w as any);
  await assert.rejects(
    run['rule.add']({ kind: 'rule.add', text: 'Parking: stay quiet', effect: 'stay_quiet', by }),
    /couldn’t record that/,
  );
  await assert.rejects(run['note.write']({ kind: 'note.write', title: 'T', text: 'a line', by }), /couldn’t record that/);
  await assert.rejects(run['note.forget']({ kind: 'note.forget', noteId: keep.id, by }), /couldn’t record that/);
  fix();
  assert.equal(w.notes.view().find((n: any) => n.title === 'Keep').lines.length, 1, 'nothing was forgotten');
  assert.equal(w.learning.view().rules.length, 1);
});

test('a call with a value too long to show the owner whole is refused before any card is made', async (t) => {
  const { w } = await intents(t);
  const code = await w.home.gate
    .run({ chatId: 'momo-chat', tool: 'gmail.send', args: { to: 'a@example.com', body: 'x'.repeat(1500) }, origin: 'chat' }, () => 1)
    .catch((e: any) => e.code);
  assert.equal(code, 'invalid');
  assert.equal((await w.gate.cards('phone:a')).length, 0);
});

test('note.restore brings back the lines the nightly tidy let go in that note, only that note’s, once; and says so when there is nothing to bring back', async (t) => {
  const { w, run } = await intents(t);
  const by = { id: 'phone:a' };
  const mail = (id: string, text: string) => ({ id, kind: 'mail', at: '2026-11-22T10:00:00.000Z', text, owner: false });
  const addFrom = (title: string, text: string, quote: string, sourceId: string, from: any) =>
    w.notes.ops([{ type: 'add', title, kind: 'person', sourceId, text, quote }], {
      chatId: 'momo-chat',
      sources: [from],
      trigger: 'change',
    });
  await addFrom('Dana', 'Likes tea', 'likes tea a lot', 'mail1', mail('mail1', 'Dana likes tea a lot'));
  await addFrom('Sam', 'Likes coffee', 'likes coffee a lot', 'mail2', mail('mail2', 'Sam likes coffee a lot'));
  const [dana, sam] = w.notes.view();
  await assert.rejects(run['note.restore']({ kind: 'note.restore', noteId: dana.id, by }), /let nothing go/);
  w.clock.at += 70 * 24 * 3600_000;
  await w.notes.tidyIfDue('system');
  const live = (title: string) =>
    w.notes
      .view()
      .find((n: any) => n.title === title)
      .lines.filter((l: any) => l.status !== 'let-go').length;
  assert.deepEqual([live('Dana'), live('Sam')], [0, 1], 'the tidy let go of at most a fifth, in one note');
  const gone = [dana, sam].find((n) => live(n.title) === 0) as typeof dana;
  const kept = [dana, sam].find((n) => n !== gone) as typeof dana;
  await assert.rejects(run['note.restore']({ kind: 'note.restore', noteId: kept.id, by }), /let nothing go/);
  const { breakAudit } = await import('./support/host/momoCoreWorld.ts');
  const fix = breakAudit(w as any);
  await assert.rejects(run['note.restore']({ kind: 'note.restore', noteId: gone.id, by }), /couldn’t record that/);
  fix();
  await run['note.restore']({ kind: 'note.restore', noteId: gone.id, by });
  assert.equal(live(gone.title), 1, 'the line is back');
  assert.equal(live(kept.title), 1);
  await assert.rejects(run['note.restore']({ kind: 'note.restore', noteId: gone.id, by }), /already been brought back/);
});

const mailLine = async (w: any, n: number) => {
  const from = { id: `mail-${n}`, kind: 'mail', at: '2026-11-22T10:00:00.000Z', text: 'Dana likes a lot of things', owner: false };
  await w.notes.ops(
    [{ type: 'add', title: 'Pad', kind: 'person', sourceId: from.id, text: `Likes thing ${n}`, quote: 'likes a lot of things' }],
    {
      chatId: 'momo-chat',
      sources: [from],
      trigger: 'change',
    },
  );
};

test('note.restore says lines when the tidy let go of several', async (t) => {
  const { w, run } = await intents(t);
  for (let i = 0; i < 12; i++) await mailLine(w, i);
  const [pad] = w.notes.view();
  assert.equal(pad.lines.length, 12);
  w.clock.at += 70 * 24 * 3600_000;
  await w.notes.tidyIfDue('system');
  assert.equal(w.notes.view()[0].lines.filter((l: any) => l.status === 'let-go').length, 2, 'at most a fifth');
  await run['note.restore']({ kind: 'note.restore', noteId: pad.id, by: { id: 'phone:a' } });
  assert.equal(w.notes.view()[0].lines.filter((l: any) => l.status === 'let-go').length, 0);
  assert.match(JSON.stringify(w.notes.view()[0].history), /brought back 2 lines/);
});

test('note.restore has nothing to bring back when the owner already brought the line back', async (t) => {
  const { w, run } = await intents(t);
  await mailLine(w, 1);
  const [pad] = w.notes.view();
  w.clock.at += 70 * 24 * 3600_000;
  await w.notes.tidyIfDue('system');
  const letGo = w.notes.view()[0].lines.find((l: any) => l.status === 'let-go');
  await w.notes.bringBack(letGo.id, 'phone:a');
  await assert.rejects(run['note.restore']({ kind: 'note.restore', noteId: pad.id, by: { id: 'phone:a' } }), /let nothing go/);
});

test('the owner’s rules in words are given to the judge and the brain, bounded, as what they said; the page shows them as saved until both read them, then as on', async (t) => {
  const { w, run } = await intents(t);
  const by = { id: 'phone:a' };
  const learning = w.learning;
  assert.deepEqual(learning.ownerRules(), []);
  await run['rule.add']({ kind: 'rule.add', text: 'Invoices: tell me when they arrive', effect: 'tell_now', by });
  await run['rule.add']({ kind: 'rule.add', text: 'Parking: stay quiet', effect: 'stay_quiet', by });
  await run['rule.add']({ kind: 'rule.add', text: 'x'.repeat(300), effect: 'ask_first', by });
  const sug = await learning.suggest({ text: 'Always ask before sending to a new address', sourceId: 'm', quote: 'q' });
  assert.equal(learning.ownerRules().length, 3, 'a suggestion that was not accepted is not an instruction');
  await run['rule.accept']({ kind: 'rule.accept', id: sug.id, by });
  assert.deepEqual(
    learning.ownerRules().map((r: any) => r.kind),
    ['tell_now', 'stay_quiet', 'ask_first', 'instruction'],
  );
  assert.equal(learning.ownerRules()[0].text, 'Invoices: tell me when they arrive');
  assert.ok(learning.ownerRules().every((r: any) => r.text.length <= 300));
  const states = () => learning.view().rules.map((r: any) => r.state);
  assert.deepEqual(states(), ['saved', 'saved', 'saved', 'saved']);
  learning.appliedBy('notice');
  learning.appliedBy('somebody-else' as any);
  assert.equal(states()[0], 'saved', 'the brain does not read them yet');
  learning.appliedBy('brain');
  assert.deepEqual(states(), ['on', 'on', 'on', 'on']);
  // a rule that is off is not an instruction
  await run['rule.turnOff']({ kind: 'rule.turnOff', id: learning.view().rules[0].id, by });
  assert.equal(learning.ownerRules().length, 3);
  // never more than the cap (100 rules of the owner's that are on), and none off the home
  for (let i = 0; i < 100; i++)
    await run['rule.add']({ kind: 'rule.add', text: `Rule number ${i}`, effect: 'stay_quiet', by }).catch(() => undefined);
  assert.equal(learning.ownerRules().length, 100, 'the one turned off does not hold a place: a hundred are on');
  const away = await world(t);
  away.home.stamp = () => null;
  assert.deepEqual(away.learning.ownerRules(), []);
});

test('what is given to the judge and the brain is capped in characters as well as in rules: twenty of three hundred', async (t) => {
  const { w, run } = await intents(t);
  for (let i = 0; i < 30; i++)
    await run['rule.add']({
      kind: 'rule.add',
      text: `${i}`.padStart(3, '0') + 'x'.repeat(297),
      effect: 'stay_quiet',
      by: { id: 'phone:a' },
    });
  const given = w.learning.ownerRules();
  assert.equal(given.length, 20);
  assert.ok(given.reduce((n: number, r: any) => n + r.text.length, 0) <= 6000);
  assert.ok(given.every((r: any) => r.text.length <= 300));
  assert.equal(given[0].text.slice(0, 3), '000', 'the oldest first');
});

test('through host.momoLaneIntent a `by`, `device` or `principal` the client sends is dropped before any handler sees it: the connection says who tapped', async (t) => {
  const { w } = await intents(t);
  const seen: any[] = [];
  const registry = {
    intents: () => ({
      'approval.send': async (i: any) => void seen.push(i),
    }),
  };
  const { handlers } = laneIntent({ momo: { granted: () => true, intentRegistry: () => registry } as any });
  const forged = { kind: 'approval.send', id: 'c1', by: 'other', device: { id: 'x' }, principal: { kind: 'desktop' } };
  assert.deepEqual(await handlers['host.momoLaneIntent']({ intent: forged }, 'owner', phone), { ok: true, value: null });
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['by', 'id', 'kind']);
  assert.match(seen[0].id, /c1/);
  assert.match(seen[0].by.id, /^phone:[0-9a-f]{12}$/);
  assert.equal(seen[0].device, undefined);
  assert.equal(seen[0].principal, undefined);
  assert.ok(w);
});
