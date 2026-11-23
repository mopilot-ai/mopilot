// The Mobile Remote dev host end to end: the real phone runtime pairs with it and drives a seeded chat, a scripted turn with an approval, a review over its git repository and a terminal, then the host restarts and keeps the pairing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import WebSocket from 'ws';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPhone, until, client, phoneReview } from './support/mobileStack.ts';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const lines: string[] = [];
const open = async (dir: string, o: object = {}) => {
  const host = await startHost({
    dir,
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: (l: string) => lines.push(l),
    sleep: async () => undefined,
    ...o,
  });
  after(() => host.stop());
  return host;
};
/** The phone harness signs in with tokens of the host's own account key. */
const relayOf = (host: any) =>
  ({
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  }) as any;

test('a phone pairs with the host, runs a scripted turn with an approval, reviews the repository and uses a terminal', async () => {
  const dir = path.join(scratch, 'one');
  const host = await open(dir);
  const phone = await startPhone(relayOf(host), { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr, 'Test iPhone');
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  assert.ok(
    lines.some((l) => /pairing: Test iPhone asks to pair; safety number \d+/.test(l)),
    'the safety number is logged',
  );
  await phone.runtime.connect(phone.snap().pairs[0].pairId);

  // `run push` is the Mac's own push request to the relay: with no push keys the relay says so, and it names the paired phone
  assert.match(
    await host.scenarios.run('push'),
    /^needsYou for “Clean up the generated files”: Test iPhone (disabled|no_token|suppressed)$/,
  );
  await assert.rejects(
    Promise.resolve().then(() => host.scenarios.run('push', ['needsYou', 'no-such-chat'])),
    /No chat no-such-chat\./,
  );
  const hello = await phone.ask('machine.hello');
  assert.equal(hello.app, 'dev-host');
  assert.equal(hello.capabilities.mirrors, true);
  assert.deepEqual(
    host.devices().map((d: any) => d.name),
    ['Test iPhone'],
  );

  // seeded chats, newest first, one of them waiting, two of them linked sessions that name the chat that started them, one holding every message MoPilot wrote itself, one carrying test pictures
  const { chats } = await phone.ask('chats.recent', { limit: 10, archived: false });
  assert.equal(chats.length, 8);
  assert.deepEqual(
    chats.filter((c: any) => c.parentId).map((c: any) => [c.parentId, c.ended]),
    [
      ['dev-seed-readme', undefined],
      ['dev-seed-readme', 'finished'],
      ['dev-seed-readme', 'failed'],
    ],
  );
  // the waiting sub-session is waiting like any chat; its parent names it
  assert.equal(chats.find((c: any) => c.id === 'dev-seed-linked-ask').state, 'waiting');
  assert.equal(chats.find((c: any) => c.id === 'dev-seed-waiting').state, 'waiting');

  // a chat started from the phone streams a reply, asks, and finishes after the phone allows it
  const request = client.ownedRequest(phone.runtime);
  const { chatId } = await client.startChat(request, {
    harness: 'codex',
    text: 'check the repo',
    projectId: 'dev-repo',
    model: null,
    effort: null,
    permission: null,
    account: null,
    worktree: false,
    startId: '22222222-2222-4222-8222-222222222222',
    attachments: [],
  });
  const snap = await phone.ask('chat.follow', { chatId });
  assert.equal(snap.chatId, chatId);
  // the card is in the snapshot when the turn was faster than the follow, else it fills in separately
  const asked = () =>
    snap.session.cards[0]
      ? { card: snap.session.cards[0], rev: snap.rev }
      : phone
          .eventsOf('cards.changed')
          .filter((e) => e.chatId === chatId && e.cards?.length)
          .map((e) => ({ card: e.cards[0], rev: e.cards[0].rev }))
          .at(-1);
  await until(asked, 'the approval card');
  const { card, rev } = asked()!;
  assert.equal(card.detail, 'git status --short');
  assert.deepEqual(await phone.ask('card.answer', { chatId, cardId: card.id, rev, key: 'once' }), { answered: true });
  await host.app.idle();
  assert.match(lines.join('\n'), /phone [\w-]+ → card\.answer/);
  assert.match(lines.join('\n'), /← event items\./);

  // the review reads the real repository
  const caps = await client.capabilities(request);
  const changes = await phoneReview.listChanges(request, chatId, 'uncommitted', caps);
  assert.deepEqual(changes.files.map((f: any) => f.path).sort(), ['notes/todo.md', 'src/price.ts']);
  const file = changes.files.find((f: any) => f.path === 'src/price.ts');
  const diff = await phoneReview.readDiff(request, chatId, file, 'uncommitted', 0, caps);
  assert.ok(diff.rows.some((r: any) => r.k === 'add' && r.t.includes('discount')));
  assert.match((await phoneReview.readFile(request, chatId, 'README.md', 0, caps)).text, /Shop/);

  // a terminal: a real shell in the repository
  assert.deepEqual(await phone.ask('pty.open', { chatId, stream: 's1', cols: 80, rows: 24 }), {
    stream: 's1',
    resumed: false,
    at: 0,
    truncated: false,
  });
  await phone.ask('pty.write', { stream: 's1', data: 'echo dev-host-$((40+2))\n' });
  await until(
    () =>
      phone
        .eventsOf('pty.data')
        .map((e) => Buffer.from(e.data, 'base64').toString())
        .join('')
        .includes('dev-host-42'),
    'the shell output',
  );
  await phone.ask('pty.close', { stream: 's1' });

  // the frame mirror starts and stops without a surface to show
  assert.deepEqual(await phone.ask('frames.subscribe', { chatId }), { subscribed: true, active: false });
  await phone.ask('frames.unsubscribe', { chatId });

  // a request the Mac refuses is logged with its code, whether the service or the schema refused it
  await assert.rejects(phone.ask('chat.follow', { chatId: 'nope' }), /isn't in MoPilot/);
  await assert.rejects(phone.ask('chat.follow', {}), /./);
  await assert.rejects(phone.ask('chat.send', { chatId: 'nope', text: 'hi' }), /isn't in MoPilot/);
  assert.match(lines.join('\n'), /← chat\.follow \d+ms ERROR gone: /);
  assert.match(lines.join('\n'), /← chat\.follow \d+ms ERROR invalid: /);
  assert.match(lines.join('\n'), /← chat\.send \d+ms ERROR gone: /);
  const transport = host.service.transport!;
  assert.equal(transport.presence(phone.snap().pairs[0].pairId), 'online');

  // the account routes share the relay's port, and the rest of the relay answers as before
  assert.equal((await fetch(`${host.accountUrl}/healthz`)).status, 200);
  assert.equal((await fetch(`${host.accountUrl}/desktop/authorize`)).status, 400);
  assert.match(lines.join('\n'), /account: GET \/desktop\/authorize/);

  // a Turn-scope review has no saved turn to show
  await assert.rejects(phoneReview.listChanges(request, chatId, 'turn', caps), /aren't available/);
  await host.stop();
  await host.stop();
  assert.equal(await host.stop(), undefined);
});

test('after a restart the host keeps the pairing and the phone reconnects without pairing again', async () => {
  const dir = path.join(scratch, 'two');
  const first = await open(dir);
  const phone = await startPhone(relayOf(first), { userId: 'dev-user', relayUrl: first.relayUrl });
  await phone.pair((await first.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const [pair] = phone.snap().pairs;
  // this runtime has connected by itself; the one below takes over its device, so it leaves first
  phone.runtime.disconnect();
  await first.stop();

  // the phone trusts one relay address, so a restart keeps the port (the default 8787 does)
  const second = await open(dir, { port: first.port });
  assert.deepEqual(second.devices().length, 1, 'the Mac still lists the phone');
  const again = await startPhone(relayOf(second), {
    userId: 'dev-user',
    id: phone.env.id,
    storage: phone.storage,
    relayUrl: second.relayUrl,
  });
  assert.equal(again.snap().pairs[0].pairId, pair.pairId);
  await again.runtime.connect(pair.pairId);
  assert.equal((await again.ask('machine.hello')).app, 'dev-host');
});

test('a session that pauses on the host is logged with its counters, and again when it is back', async () => {
  const host = await open(path.join(scratch, 'pause'));
  const phone = await startPhone(relayOf(host), { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  const devices = host.remote.devices!;
  const update = devices.update.bind(devices);
  let failures = 1;
  devices.update = async (...args: any[]) => {
    if (args[1]?.rx && failures-- > 0) throw new Error('disk full');
    return update(...args);
  };
  const before = lines.length;
  phone.runtime.send('chat-1', 'hello');
  await until(
    () => lines.slice(before).some((l) => /channel: session back after storage/.test(l)),
    'the host to log that the session is back',
    25_000,
  );
  const log = lines.slice(before);
  assert.ok(
    log.some((l) => /channel: session storage for p_\S+ \{"dropped":0,.*"pauses":\{"overload":0,"storage":1\}/.test(l)),
    log.join('\n'),
  );
});

test('a host started with --ask style confirmation declines a pairing the user declines', async () => {
  const host = await open(path.join(scratch, 'three'), { confirm: async () => 'deny' });
  const phone = await startPhone(relayOf(host), { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr).catch(() => undefined);
  await until(() => lines.some((l) => l.includes('pairing: declined')), 'the pairing to be declined');
  assert.equal(host.devices().length, 0);
});

test('a host that cannot finish starting closes what it opened', async () => {
  // the Mac side cannot make its identity (a file where its folder belongs)
  const noMac = path.join(scratch, 'four');
  mkdirSync(noMac, { recursive: true });
  writeFileSync(path.join(noMac, 'mac'), 'in the way');
  await assert.rejects(open(noMac), /Mobile Remote did not start/);
  // the sealed-storage key cannot be read (a folder where its file belongs)
  const noKey = path.join(scratch, 'five');
  mkdirSync(path.join(noKey, 'safe.key'), { recursive: true });
  await assert.rejects(open(noKey), /EISDIR/);
  // the relay's database cannot open (a file where its folder belongs)
  const noDb = path.join(scratch, 'ten');
  mkdirSync(noDb, { recursive: true });
  writeFileSync(path.join(noDb, 'relay-db'), 'in the way');
  await assert.rejects(open(noDb));
  // the Mac does not reach its relay in time
  await assert.rejects(open(path.join(scratch, 'six'), { readyMs: -1 }), /did not reach its own relay/);
  // each failed start released its port and database: the same folders start fine once the cause is gone
  rmSync(path.join(noMac, 'mac'));
  rmSync(path.join(noKey, 'safe.key'), { recursive: true });
  rmSync(path.join(noDb, 'relay-db'));
  for (const dir of [noMac, noKey, noDb, path.join(scratch, 'six')]) assert.equal((await open(dir)).devices().length, 0);
});

test('a second host on the same port fails before it touches the first one’s database', async () => {
  const dir = path.join(scratch, 'seven');
  const first = await open(dir);
  await assert.rejects(open(path.join(scratch, 'eight'), { port: first.port }), /is another dev host running\?/);
  assert.ok(!existsSync(path.join(scratch, 'eight', 'relay-db')), 'the second host opened no database');
  assert.equal((await fetch(`${first.accountUrl}/healthz`)).status, 200);
});

test('a request line that is not a URL gets a 400 and the host keeps serving; stop is one promise', async () => {
  const host = await open(path.join(scratch, 'nine'));
  const reply = await new Promise<string>((resolve) => {
    const socket = net.connect(host.port, '127.0.0.1', () => socket.write('GET //% HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let text = '';
    socket.on('data', (d) => (text += d));
    socket.on('close', () => resolve(text));
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal((await fetch(`${host.accountUrl}/healthz`)).status, 200);
  const one = host.stop();
  assert.equal(host.stop(), one);
  await one;
});

test('the terminal reports a repaired spawn-helper in the log', async () => {
  await open(path.join(scratch, 'eleven'), { ptyOptions: { repair: () => '/fake/spawn-helper' } });
  assert.ok(lines.some((l) => l.includes("terminal: gave node-pty's spawn-helper its execute bit (/fake/spawn-helper)")));
});

test('bench scenarios reach a real phone: a plan card with its text, a card answered on the Mac, and the log explains what happened', async () => {
  const host = await open(path.join(scratch, 'twelve'));
  const phone = await startPhone(relayOf(host), { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);

  const planChat = /chat (dev-bench-\d+)/.exec(host.scenarios.run('plan') as string)![1];
  await until(async () => (await host.app.ops.cardsOf(planChat)).length, 'the plan card');
  const planSnapshot = await phone.ask('chat.follow', { chatId: planChat });
  const plan = planSnapshot.session.cards[0];
  assert.equal(plan.kind, 'plan');
  assert.match(plan.plan.text, /^# Plan: round the checkout total once/);
  await phone.ask('card.answer', { chatId: planChat, cardId: plan.id, rev: planSnapshot.rev, key: 'approve' });

  const elsewhere = /chat (dev-bench-\d+)/.exec(host.scenarios.run('answered-elsewhere', ['1']) as string)![1];
  await until(async () => (await host.app.ops.cardsOf(elsewhere)).length, 'the card');
  await phone.ask('chat.follow', { chatId: elsewhere });
  // the Mac answers one second later: the card update takes it down on the phone
  await until(() => phone.eventsOf('cards.changed').some((e) => e.chatId === elsewhere && e.cards?.length === 0), 'the card to go');
  await host.app.idle();

  const log = lines.join('\n');
  assert.match(log, new RegExp(`↳ the phone opens chat ${planChat}: it gets the saved history`));
  assert.match(log, /↳ the phone answers the card in chat dev-bench-\d+ with "approve"/);
  assert.match(log, /↳ chat dev-bench-\d+ changed state \([^)]*turn[^)]*\)/);
  assert.match(log, new RegExp(`← event cards.changed chat=${elsewhere} rev=\\d+`));
  assert.match(log, /card answered on the Mac with "once"/);
});

test('bench controls on a real phone: MoMo on and off, the brain switch, the Mac asleep, the relay restarting, and the Mac removing the phone', async () => {
  const host = await open(path.join(scratch, 'thirteen'));
  const phone = await startPhone(relayOf(host), { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const [pair] = phone.snap().pairs;
  await phone.runtime.connect(pair.pairId);

  // MoMo is off until a scenario turns it on
  assert.equal((await phone.ask('machine.hello')).capabilities.momo, undefined);
  await assert.rejects(phone.ask('momo.memory.list'), /Unknown request: momo\.memory\.list/);
  await host.scenarios.run('momo', ['on']);
  const hello = await phone.ask('machine.hello');
  assert.equal(hello.capabilities.momo, true);
  assert.equal(hello.capabilities.momoBrainSet, false);
  assert.equal((await phone.ask('momo.memory.list')).facts.length, 3);
  assert.equal((await phone.ask('momo.chat.follow', { items: 3 })).chatId, 'dev-momo-main');
  await assert.rejects(
    phone.ask('momo.brain.set', { brain: { harness: 'claude', account: null, model: null, modelLabel: null } }),
    /Allow brain changes from this Mac first/,
  );
  await host.scenarios.run('brain-switch', ['on']);
  assert.equal((await phone.ask('machine.hello')).capabilities.momoBrainSet, true);
  await phone.ask('momo.brain.set', { brain: { harness: 'claude', account: null, model: 'dev-deep', modelLabel: 'Dev Deep' } });
  assert.equal((await phone.ask('momo.brain.get')).brain.modelLabel, 'Dev Deep');
  await until(() => phone.eventsOf('momo.changed').some((e) => e.area === 'brain'), 'the brain change');
  // a reminder MoMo raises through the host console reaches the phone's chat with its loop, and answering it closes the loop
  await host.scenarios.run('momo-remind', ['Call', 'the', 'bank']);
  const reminded = (await phone.ask('momo.chat.follow', { items: 10 })).items.find((r: any) => r.nudge);
  assert.equal(reminded.nudge.title, 'Call the bank');
  await phone.ask('momo.loops.act', { loopId: reminded.nudge.loopId, action: 'done' });
  assert.deepEqual((await phone.ask('momo.loops.list')).loops, []);
  // the Tasks method is listed (with a card up) or hidden, as an older Mac would
  const listed = async () => (await phone.ask('machine.hello')).capabilities.methods.includes('momo.tasks.list');
  assert.equal(await listed(), true);
  await host.scenarios.run('momo-tasks');
  const tasks = (await phone.ask('momo.tasks.list')).tasks;
  // the Mac's four-tab panel: the card, the loops, the runs and the routines
  assert.deepEqual([...new Set(tasks.map((t: any) => t.kind))].sort(), ['card', 'loop', 'routine', 'run']);
  await host.scenarios.run('momo-tasks', ['off']);
  assert.equal(await listed(), false);
  await assert.rejects(phone.ask('momo.tasks.list'));
  await host.scenarios.run('momo-tasks', ['on']);
  assert.equal(await listed(), true);
  // a draft MoMo wrote reaches the phone's chat as a note row with its words; a long one is a second row; off takes them out
  const drafts = async () => (await phone.ask('momo.chat.follow', { items: 20 })).items.filter((r: any) => r.draft);
  assert.match(await host.scenarios.run('momo-draft'), /a draft for two people is in MoMo’s chat/);
  assert.deepEqual(
    (await drafts()).map((r: any) => r.draft.to),
    [['sam@example.com', 'lee@example.com']],
  );
  assert.match(await host.scenarios.run('momo-draft', ['long']), /a long draft/);
  assert.equal((await drafts()).length, 2);
  assert.match(await host.scenarios.run('momo-draft', ['off']), /2 drafts removed/);
  assert.equal((await drafts()).length, 0);
  // the page shell: the Mac's MoMo state says nothing of it until `momo-shell on`, then says it, with the Tasks panel, and tells the phone to read again
  assert.equal('shell' in (await phone.ask('momo.state.get')), false);
  await host.scenarios.run('momo-shell');
  const shellState = await phone.ask('momo.state.get');
  assert.deepEqual([shellState.shell, shellState.shellTasks], [true, true]);
  await until(() => phone.eventsOf('momo.changed').some((e) => e.area === 'prefs'), 'the shell change');
  await host.scenarios.run('momo-shell', ['off']);
  assert.equal('shell' in (await phone.ask('momo.state.get')), false);
  // a send's card in MoMo's chat names its recipients, as the Mac's card for a phone does; blocked has only Dismiss; an older Mac has no count
  // the card momo-tasks put up is answered first: MoMo's chat asks one card at a time
  assert.equal(host.app.macAnswers('dev-momo-main', 'deny'), true);
  await until(async () => !(await host.app.ops.cardsOf('dev-momo-main')).length, 'the tasks card answered');
  const cardOf = async (shape?: string) => {
    await host.scenarios.run('momo-recipients', shape ? [shape] : []);
    await until(async () => (await host.app.ops.cardsOf('dev-momo-main')).length, 'the recipients card');
    const card = (await host.app.ops.cardsOf('dev-momo-main'))[0];
    assert.equal(host.app.macAnswers('dev-momo-main', 'deny'), true);
    await until(async () => !(await host.app.ops.cardsOf('dev-momo-main')).length, 'the card answered');
    return card;
  };
  assert.match((await cardOf()).detail, /To \(3\): person1@example.com, person2@example.com, person3@example.com$/);
  assert.match((await cardOf('many')).detail, /To \(23\): .*person20@example.com and 3 more$/);
  const blocked = await cardOf('blocked');
  assert.deepEqual([blocked.title, blocked.choices.map((c: any) => c.label)], ["MoMo can't tell who this reaches", ['Dismiss']]);
  assert.match((await cardOf('off')).detail, /To: person1@example.com$/);
  await assert.rejects(async () => host.scenarios.run('momo-recipients', ['maybe']), /Say one of three, many, blocked, off/);
  await host.scenarios.run('momo', ['off']);
  await assert.rejects(phone.ask('momo.memory.list'), /Unknown request: momo\.memory\.list/);

  // MoMo off drops a phone that followed MoMo's chat
  await host.scenarios.run('momo', ['on']);
  await phone.ask('momo.chat.follow', { items: 3 });
  assert.ok([...host.service.phones.values()][0].client.follows.has('dev-momo-main'));
  await host.scenarios.run('momo', ['off']);
  assert.ok(![...host.service.phones.values()][0].client.follows.has('dev-momo-main'));

  // the Mac sleeps: the relay tells the phone, which shows the computer as offline; the Mac wakes and the phone can connect again
  const presence = () => host.service.transport!.presence(pair.pairId);
  assert.equal(presence(), 'online');
  host.scenarios.run('sleep', ['1']);
  assert.equal(presence(), 'sleeping');
  await until(() => phone.snap().phase === 'offline', 'the phone to see the Mac asleep', 4000);
  await until(() => presence() === 'online', 'the Mac to wake', 4000);
  await until(
    async () =>
      (await phone.runtime.connect(pair.pairId).then(
        () => true,
        () => false,
      )) === true,
    'the phone to connect again',
    10000,
  );

  // the Mac drops off the network: the relay loses it, the phone sees it gone, and the Mac comes back by itself
  host.scenarios.run('unplug', ['2']);
  await until(() => phone.snap().phase === 'offline', 'the phone to see the Mac gone', 8000);
  await until(
    async () =>
      (await phone.runtime.connect(pair.pairId).then(
        () => true,
        () => false,
      )) === true,
    'the Mac to be back',
    30000,
  );
  assert.equal((await phone.ask('machine.hello')).v, 1);

  // the relay restarts: both sides reconnect by themselves and the pair still works; a second restart meanwhile is refused
  host.scenarios.run('restart-relay', ['1']);
  host.scenarios.run('restart-relay', ['1']);
  await until(
    () => lines.some((l) => l.includes('bench: the relay restart failed: A relay restart is already under way.')),
    'the second restart to be refused',
  );
  await until(() => lines.some((l) => l.includes('bench: the relay restart finished')), 'the relay to come back', 8000);
  await until(
    async () =>
      (await phone.runtime.connect(pair.pairId).then(
        () => true,
        () => false,
      )) === true,
    'the phone to talk to the Mac again',
    30000,
  );
  assert.equal((await phone.ask('machine.hello')).v, 1);

  // the Mac removes the phone: the phone forgets the computer
  assert.match(await (host.scenarios.run('revoke', ['1']) as Promise<string>), /was removed on the Mac/);
  await until(() => phone.snap().pairs.length === 0, 'the phone to forget the computer', 10000);
  assert.equal(host.devices().length, 0);
});

test('stopping the host while the relay is down leaves nothing listening, and a Mac that is cut off is refused at the door but phones are not', async () => {
  const host = await open(path.join(scratch, 'fourteen'));
  host.scenarios.run('restart-relay', ['2']);
  const stopped = host.stop();
  await stopped;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  // the port is free again: nothing came back up behind the stop
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer().once('error', reject);
    probe.listen(host.port, '127.0.0.1', () => probe.close(() => resolve()));
  });

  const second = await open(path.join(scratch, 'fifteen'));
  second.scenarios.run('unplug', ['3']);
  const wsUrl = second.relayUrl;
  const attempt = (token: string | null) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(wsUrl, token ? { headers: { authorization: `Bearer ${token}` } } : {});
      ws.once('open', () => (ws.close(), resolve('open')));
      ws.once('error', () => resolve('refused'));
      ws.once('unexpected-response', () => resolve('refused'));
    });
  assert.equal(await attempt(await second.account.sign('mac-dev-host', false, 'relay')), 'refused', 'the Mac is cut off');
  assert.equal(await attempt(null), 'refused', 'a request with no token is refused too');
  assert.equal(await attempt(await second.account.sign('ph_someone', true, 'relay')), 'open', 'a phone is not');
});

test('--fake-hosts: the host serves made-up machines, and the bench flips one', async () => {
  const host = await open(path.join(scratch, 'hosts'), { fakeHosts: true });
  assert.equal(host.service.hostAllowed(), true);
  assert.deepEqual(
    host.service
      .host()
      .rows()
      .map((m: any) => [m.id, m.status]),
    [
      ['ssh:studio', 'online'],
      ['ssh:old-mini', 'offline'],
    ],
  );
  assert.match(await host.scenarios.run('hosts'), /old-mini is online/);
  assert.equal(host.service.host().rows()[1].status, 'online');
  const plain = await open(path.join(scratch, 'no-hosts'));
  assert.equal(plain.service.hostAllowed(), false, 'no machines unless asked');
});
