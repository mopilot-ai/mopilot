// The dev host's stand-in for the morning brief (scripts/mobile-dev-host/fakeMomoBrief.mjs, `momo-brief [on|off|failed]`): the fake Mac keeps the brief's Scheduled row and writes its stack into MoMo's fake chat (lines, then a card per suggestion) once a day; `failed` shows why it could not start until Try again; `off` is a Mac without it and hides momo.brief.runNow; on a real phone the row, the card and Try again work end to end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPhone, until } from './support/mobileStack.ts';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';
import { createFakeBrief } from '../scripts/mobile-dev-host/fakeMomoBrief.mjs';
import { createControls } from '../scripts/mobile-dev-host/controls.mjs';
import { momoBriefScenario } from '../scripts/mobile-dev-host/scenariosMomoSuggestions.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-brief-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const NOW = new Date(2026, 10, 16, 6, 0).getTime();

function fake(o: { cards?: number } = {}) {
  const chat: any = { id: 'dev-momo-main', rows: [] };
  const told: string[] = [];
  const made = { n: 0, clock: NOW };
  const suggestions = Array.from({ length: o.cards ?? 3 }, (_, i) => ({
    id: `s${i + 1}`,
    title: `Suggestion ${i + 1}`,
    source: `Source ${i + 1}`,
    status: i === 2 ? 'added' : 'new',
  }));
  const b = createFakeBrief({
    now: () => made.clock,
    mainChatId: async () => (made.n++, 'dev-momo-main'),
    app: { chats: { get: () => chat } },
    changed: (a: string) => void told.push(a),
    suggestions: async () => ({ suggestions }),
  });
  return { b, chat, told, made };
}

test('off has no row; on shows the next time and writes the stack once: lines, then a card for each of two suggestions that wait', async () => {
  const { b, chat, told } = fake();
  assert.equal(b.row(), null);
  await assert.rejects(b.runNow(), /brief is off/);
  await b.setMode('on');
  assert.deepEqual(b.row(), { state: 'scheduled', nextAt: NOW + 20 * 3_600_000, reason: null });
  assert.deepEqual(
    chat.rows.map((r: any) => [r.role, r.text, r.suggestion?.id ?? null]),
    [
      ['note', 'Good morning, MoMo.', null],
      ['note', 'Your lease promise is due Friday (Your promise, Tuesday).', null],
      ['note', 'I can move 2 things forward:', null],
      ['note', 'Suggestion 1', 's1'],
      ['note', 'Suggestion 2', 's2'],
    ],
  );
  assert.equal(new Set(chat.rows.map((r: any) => r.id)).size, chat.rows.length);
  // on again the same day writes nothing more; Try again says it went out
  await b.setMode('on');
  assert.equal(chat.rows.length, 5);
  await assert.rejects(b.runNow(), /already went out today/);
  assert.deepEqual(told, ['chat', 'memory', 'memory']);
});

test('failed shows why it could not start; Try again writes the brief and clears it; a lead-in for one card reads in the singular; none has no lead-in', async () => {
  const { b, chat, made } = fake({ cards: 1 });
  await b.setMode('failed');
  assert.deepEqual(b.row(), { state: 'failed', nextAt: NOW + 20 * 3_600_000, reason: 'MoMo’s brain is not signed in.' });
  assert.equal(chat.rows.length, 0);
  await b.runNow();
  assert.equal(b.row()!.state, 'scheduled');
  assert.equal(chat.rows[2].text, 'I can move 1 thing forward:');
  // the next day it may go again
  made.clock += 24 * 3_600_000;
  await b.runNow();
  assert.equal(chat.rows.length, 8);
  const none = fake({ cards: 0 });
  await none.b.setMode('failed');
  await none.b.runNow();
  assert.deepEqual(
    none.chat.rows.map((r: any) => r.text),
    ['Good morning, MoMo.', 'Your lease promise is due Friday (Your promise, Tuesday).'],
  );
});

test('the scenario takes on, off or failed (on by default) and says what it did; anything else shows the usage', () => {
  const seen: string[] = [];
  const sc = momoBriefScenario(() => ({ momoBrief: (m: any) => (seen.push(m), `did ${m}`) }));
  assert.equal(sc.usage, 'momo-brief [on|off|failed]');
  assert.deepEqual([sc.run([]), sc.run(['off']), sc.run(['failed'])], ['did on', 'did off', 'did failed']);
  assert.throws(() => sc.run(['maybe']), /momo-brief \[on\|off\|failed\]/);
});

test('the control sets the bench, asks the fake and says whether MoMo itself is off', async () => {
  const asked: string[] = [];
  const bench: any = { momo: false, brain: false, tasks: true, voice: 'on' };
  const controls = createControls({
    bench,
    relayClient: () => null,
    cutMac: () => undefined,
    restartRelay: async () => undefined,
    devices: () => [],
    unpair: async () => true,
    changed: () => undefined,
    after: () => undefined,
    log: () => undefined,
    momoSwitched: () => undefined,
    momoBrief: async (m: string) => void asked.push(m),
    pushRequest: async () => 'ok',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
  } as any);
  assert.match(await controls.momoBrief('failed'), /the morning brief is failed.*MoMo itself is off/);
  bench.momo = true;
  assert.doesNotMatch(await controls.momoBrief('on'), /MoMo itself is off/);
  assert.deepEqual([bench.brief, asked], ['on', ['failed', 'on']]);
  const plain = createControls({
    bench: { momo: true },
    log: () => undefined,
    changed: () => undefined,
    momoSwitched: () => undefined,
  } as any);
  assert.match(await plain.momoBrief('off'), /off/);
});

test('with suggestions off the brief’s stack has no suggestion cards, only its lines', async () => {
  const host = await startHost({
    dir: path.join(scratch, 'host2'),
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
  await host.scenarios.run('momo', ['on']);
  await host.scenarios.run('momo-suggestions', ['off']);
  await host.scenarios.run('momo-brief', ['on']);
  const chat = await phone.ask('momo.chat.follow', { items: 30 });
  assert.ok(chat.items.some((r: any) => /Good morning/.test(r.text ?? '')));
  assert.equal(
    chat.items.some((r: any) => r.suggestion),
    false,
  );
});

test('on a real phone: the row, the stack in MoMo’s chat, Try again, and off hiding the method', async () => {
  const host = await startHost({
    dir: path.join(scratch, 'host'),
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
  await host.scenarios.run('momo', ['on']);
  const listed = async () => (await phone.ask('machine.hello')).capabilities.methods.includes('momo.brief.runNow');
  const rows = async () => (await phone.ask('momo.tasks.list')).tasks.filter((t: any) => t.kind === 'brief');
  // off by default: no row and no method
  assert.equal(await listed(), false);
  assert.deepEqual(await rows(), []);
  await assert.rejects(phone.ask('momo.brief.runNow'));
  await host.scenarios.run('momo-brief', ['failed']);
  assert.equal(await listed(), true);
  assert.deepEqual(
    (await rows()).map((t: any) => [t.id, t.state, t.detail]),
    [['brief:morning', 'failed', 'MoMo’s brain is not signed in.']],
  );
  assert.equal((await phone.ask('momo.brief.runNow')).ran, true);
  assert.equal((await rows())[0].state, 'scheduled');
  const chat = await phone.ask('momo.chat.follow', { items: 30 });
  assert.ok(chat.items.some((r: any) => r.suggestion?.id));
  await assert.rejects(phone.ask('momo.brief.runNow'), /already went out today/);
  await host.scenarios.run('momo-brief', ['off']);
  assert.equal(await listed(), false);
  assert.deepEqual(await rows(), []);
});
