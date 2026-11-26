// The dev host serves MoMo's home to a phone (scripts/mobile-dev-host/scenariosMomoHome.mjs, `momo-home`): nothing of it exists until the scenario turns it on, then the real phone transport reads the view and sends an intent, hears the change event, and `off` takes it all away again.
import { parseFixId } from '../shared/momoFixId.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPhone, until } from './support/mobileStack.ts';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-momo-home-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('a phone reads the home the dev host serves, sends an intent, hears the change, and off takes it away', async () => {
  const host = await startHost({
    dir: path.join(scratch, 'one'),
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: () => undefined,
    sleep: async () => undefined,
  });
  after(() => host.stop());
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  // nothing of the home exists before the scenario: no hello field, no method
  assert.equal((await phone.ask('machine.hello')).capabilities.momoHome, undefined);
  await assert.rejects(phone.ask('momo.home.view'));
  assert.match(String(await host.scenarios.run('momo-home', ['move-stuck', 'lost'])), /served in "move-stuck".*lost/);
  assert.equal((await phone.ask('machine.hello')).capabilities.momoHome, true);
  const read = await phone.ask('momo.home.view');
  assert.equal(typeof read.view.home.state, 'string');
  const done = await phone.ask('momo.home.intent', { intent: { kind: 'move', toId: 'mini' } });
  assert.equal(done.ok, true);
  await until(() => phone.eventsOf('momo.home.changed').length > 0, 'the home change');
  // a wrong word is refused, and off takes the home away
  await assert.rejects(
    Promise.resolve().then(() => host.scenarios.run('momo-home', ['nope'])),
    /Usage: momo-home/,
  );
  await assert.rejects(
    Promise.resolve().then(() => host.scenarios.run('momo-home', ['running', 'nope'])),
    /The word after the scenario is rows, one of/,
  );
  // rows adds the shared fixture's cards to the chat, and the next scenario takes them away
  assert.match(String(await host.scenarios.run('momo-home', ['running', 'rows'])), /fixture cards/);
  const cards = (await phone.ask('momo.home.view')).view.chat.map((r: { kind: string }) => r.kind);
  assert.deepEqual(
    ['approval', 'question', 'result', 'watch-changed', 'draft'].filter((k) => cards.includes(k)),
    ['approval', 'question', 'result', 'watch-changed', 'draft'],
  );
  // the lanes that are not registered are stood in for, so the note form and the cards can be pressed
  const asked = async (intent: object) => (await phone.ask('momo.home.intent', { intent })).view;
  // a notice that offers Not needed, and a draft cut to its size
  const chat = () => phone.ask('momo.home.view').then((r: any) => r.view.chat as any[]);
  const notice = (await chat()).find((r) => r.id === 'notice:dana:1');
  assert.deepEqual([notice.notNeeded, notice.decision.decisionId], [{ suggestion: null }, 'dec-dana-1']);
  assert.equal((await chat()).find((r) => r.id === 'draft:acme-renewal:cut').truncated, true);
  // the brief that lists what a rule kept quiet: Undo rule on the line with a rule, and the line no longer offers it
  const quiet = (await chat()).find((r) => r.id === 'brief:quiet:1').brief.keptQuiet;
  assert.deepEqual(
    quiet.map((k: any) => k.ruleId),
    ['rule-newsletters', null],
  );
  const undone = await asked({ kind: 'rule.undo', id: 'rule-newsletters' });
  assert.deepEqual(
    undone.chat.find((r: any) => r.id === 'brief:quiet:1').brief.keptQuiet.map((k: any) => k.ruleId),
    [null, null],
  );
  // the Tasks and Notes tabs have rows to press: a working task with Stop, tasks that failed for a missing and a signed-out agent, and the notes with lines
  const view = () => phone.ask('momo.home.view').then((r: any) => r.view);
  const first = await view();
  assert.deepEqual(
    first.tasks.map((t: any) => [t.id, t.state, t.failure?.code ?? null]).filter((x: any[]) => x[0].startsWith('t')),
    [
      ['t1', 'working', null],
      ['t2', 'watching', null],
      ['t-missing', 'failed', 'agent-missing'],
      ['t-signed-out', 'failed', 'agent-signed-out'],
    ],
  );
  assert.ok(first.notes.length > 0 && first.notes[0].lines.length > 0);
  await asked({ kind: 'task.stop', id: 't1' });
  assert.equal((await view()).tasks.find((t: any) => t.id === 't1').state, 'stopped');
  const line = first.notes[0].lines[0];
  const reworded = await asked({ kind: 'note.edit', noteId: first.notes[0].id, lineId: line.id, text: 'Changed here' });
  assert.equal(reworded.notes[0].lines[0].text, 'Changed here');
  const forgot = await asked({ kind: 'note.forget', noteId: first.notes[0].id, lineId: line.id });
  assert.equal(
    forgot.notes[0].lines.some((l: any) => l.id === line.id),
    false,
  );
  // a brief with one offer (Hide and Start side by side): answered, the offer goes
  assert.equal((await chat()).find((r) => r.id === 'brief:offer:1').brief.offers.length, 1);
  const hidden = await asked({ kind: 'brief.hide', offerId: 'offer-acme' });
  assert.equal(hidden.chat.find((r: any) => r.id === 'brief:offer:1').brief.offers.length, 0);
  // Not needed is told with the decision the row was drawn from, and the row stops offering it
  const told = await asked({ kind: 'row.notNeeded', rowId: notice.id, decisionId: notice.decision.decisionId });
  assert.equal(told.chat.find((r: any) => r.id === 'notice:dana:1').notNeeded, null);
  const wrote = await asked({ kind: 'note.write', title: 'Trip', text: 'Berlin in May' });
  assert.deepEqual(
    wrote.notes.map((n: { title: string }) => n.title),
    ['Acme', 'Trip'],
  );
  const answeredQ = await asked({ kind: 'question.answer', id: 'ask-pending', optionId: 'work' });
  assert.equal(answeredQ.chat.find((r: { id: string }) => r.id === 'question:pending').question.status, 'answered');
  const denied = await asked({ kind: 'approval.deny', id: 'card-pending' });
  const card = denied.chat.find((r: { id: string }) => r.id === 'approval:pending').approval;
  assert.deepEqual([card.status, card.canAskAgain], ['denied', true]);
  const edited = await asked({ kind: 'approval.edit', id: 'card-pending', body: 'New words' });
  assert.equal(edited.chat.find((r: { id: string }) => r.id === 'approval:pending').approval.body, 'New words');
  const again = await asked({ kind: 'approval.askAgain', id: 'card-pending' });
  assert.equal(again.chat.find((r: { id: string }) => r.id === 'approval:pending').approval.status, 'pending');
  await host.scenarios.run('momo-home', ['running']);
  assert.equal(
    (await phone.ask('momo.home.view')).view.chat.some((r: { kind: string }) => r.kind === 'question'),
    false,
  );
  assert.match(String(await host.scenarios.run('momo-home', ['off'])), /no longer served/);
  assert.equal((await phone.ask('machine.hello')).capabilities.momoHome, undefined);
  assert.ok(host.scenarios.list().some((s: { usage: string }) => s.usage.startsWith('momo-home')));
});

test('a cancel on the held move lets it go, and the move ends', async () => {
  const host = await startHost({
    dir: path.join(scratch, 'two'),
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: () => undefined,
  });
  after(() => host.stop());
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  await host.scenarios.run('momo-home', ['moving']);
  const outcome = async () => (await phone.ask('momo.home.view')).view.home.move?.outcome;
  // the scenario holds the move at its seal step, as a person looking at the card finds it
  await until(async () => (await phone.ask('momo.home.view')).view.home.move?.step === 'sealed', 'the held step');
  assert.equal(await outcome(), 'running');
  await phone.ask('momo.home.intent', { intent: { kind: 'move-cancel' } });
  await until(async () => (await outcome()) === 'cancelled', 'the cancelled move');
});

test('the home-safety states are served and their buttons answer as the Mac does: Use and Delete asked first, Keep and Check again at once', async () => {
  const host = await startHost({
    dir: path.join(scratch, 'safety'),
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: () => undefined,
    sleep: async () => undefined,
  });
  after(() => host.stop());
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  const problems = async () =>
    (await phone.ask('momo.home.view')).view.problems as { code: string; fix: { id: string }; also?: { id: string }[] }[];
  const press = async (id: string) => phone.ask('momo.home.intent', { intent: { kind: 'fix', id } });
  assert.match(String(await host.scenarios.run('momo-home', ['running', 'older'])), /home-safety state older/);
  const [older] = await problems();
  assert.equal(older.code, 'older_home');
  assert.deepEqual(
    [older.fix.id, ...(older.also ?? []).map((a) => a.id)],
    ['use-older:studio', 'keep-older:studio', 'delete-older:studio'],
  );
  // Delete is asked first: the words, and a confirming fix with a token; that one deletes
  const asked = await press('delete-older:studio');
  assert.equal(asked.ok, false);
  assert.match(asked.cause, /can’t be undone/);
  assert.match(asked.fix.id, /^delete-older!:[^:]+:studio$/);
  assert.equal((await press(asked.fix.id)).ok, true);
  assert.deepEqual(await problems(), []);
  // Keep at once, and the card does not come back
  await host.scenarios.run('momo-home', ['running', 'older']);
  assert.equal((await press('keep-older:studio')).ok, true);
  assert.deepEqual(await problems(), []);
  // an older MoMo on an SSH machine, whose id has colons and an @: the fix ids carry it whole and the owner's choices still reach it
  await host.scenarios.run('momo-home', ['running', 'older-colon']);
  const [onRunner] = await problems();
  assert.deepEqual(
    [onRunner.fix.id, ...(onRunner.also ?? []).map((a) => a.id)].map((id) => parseFixId(id)?.fields),
    [['ssh:runner@localhost'], ['ssh:runner@localhost'], ['ssh:runner@localhost']],
  );
  const askedRunner = await press((onRunner.also ?? [])[1].id);
  assert.equal(parseFixId(askedRunner.fix.id)?.fields.at(-1), 'ssh:runner@localhost');
  assert.equal((await press(askedRunner.fix.id)).ok, true);
  assert.deepEqual(await problems(), []);
  // a replaced move says so; a move in progress and a lost home each show theirs
  await host.scenarios.run('momo-home', ['running', 'replaced']);
  assert.match((await problems())[0].code, /older_home/);
  await host.scenarios.run('momo-home', ['running', 'blocked']);
  assert.deepEqual(
    (await problems()).map((p) => p.code),
    ['move_in_progress'],
  );
  assert.equal((await press('check-again')).ok, true);
  // an intent the home refuses carries no view, and a scenario of another bench still runs through this one
  assert.equal((await press('zzz-not-a-fix')).ok, false);
  assert.match(String(await host.scenarios.run('momo', ['on'])), /./);
  // a message typed while MoMo slept, held for the MoMo that was there after a fresh start: held, with the owner's two choices, and never sent on its own
  for (const choice of ['retry-send', 'delete-send']) {
    await host.scenarios.run('momo-home', ['running', 'held-old']);
    const held = await problems();
    assert.deepEqual(
      held.map((p: any) => [p.code, p.fix.id, p.fix.label]),
      [
        ['send_refused', 'retry-send:turn-held-0001', 'Send to this MoMo'],
        ['send_refused', 'delete-send:turn-held-0001', 'Delete message'],
      ],
    );
    const causes = (await phone.ask('momo.home.view')).view.problems.map((p: any) => p.cause);
    assert.deepEqual(causes, [
      'Not sent: “Remind me about Dana”. MoMo was started again, and this was written for the old one.',
      'Or delete “Remind me about Dana”.',
    ]);
    assert.equal((await press(`${choice}:turn-held-0001`)).ok, true);
    assert.deepEqual(await problems(), []);
  }
  for (const word of ['home-lost', 'unheard']) {
    await host.scenarios.run('momo-home', ['running', word]);
    const [problem] = await problems();
    assert.equal(problem.fix.id, 'start-fresh');
    // Start fresh acts on no first press: it is asked first, in the shared words (what is left behind, nothing deleted), and only the confirming press goes on
    const asked = await press('start-fresh');
    assert.equal(asked.ok, false);
    assert.match(asked.cause, /^Start fresh\? MoMo starts over with no memory of what it knew on Studio/);
    assert.match(asked.cause, /it will be retired when it comes back/);
    assert.deepEqual(
      (await problems()).map((p) => p.code),
      [word === 'home-lost' ? 'home_lost' : 'home_unheard'],
      'nothing was cleared by the first press',
    );
    assert.match(asked.fix.id, /^start-fresh!:[^:]+$/);
    assert.equal((await press('start-fresh!:wrong')).ok, false, 'another token does not confirm');
    assert.equal((await press(asked.fix.id)).ok, true);
    assert.deepEqual(await problems(), []);
    // and the home asks where MoMo should live: the machine picker
    const view = (await phone.ask('momo.home.view')).view;
    assert.equal(view.setup.step, 'where');
    assert.ok(view.home.machines.length > 0);
  }
});
