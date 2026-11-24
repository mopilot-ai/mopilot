// Every intent a client can send to MoMo's home is in one table (shared/momoIntents.mjs) with an owning lane, and every kind in the table is either handled on the home or listed here as still pending for its lane: a kind a client sends that no table row names, and a handler for a kind the table does not give that lane, both fail. A lane removes its kinds from PENDING in the same change that registers its handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { argsFit, createIntentRegistry, DEVICE_LANES, INTENT_TABLE, LANES } from '../shared/momoIntents.mjs';
import os from 'node:os';
import { createFakeHome } from '../shared/momoHomeFake.mjs';
// @ts-ignore
import { createMomoOutbox } from '../shared/momoOutbox.mjs';
import { createRealHome } from '../shared/momoHomeReal.mjs';
// @ts-ignore: plain ESM without declarations
import { momoHomeFor, createMomoHidden } from '../host/src/momoWiring.mjs';
import { toIntent } from '../src/components/momo/home/homeIntents.ts';

/** The kinds whose lane service has not given the Host an `intents` map yet, by lane (the Host's own registry, `home.intentRegistry()`). Shrinks as lanes land; never grows. */
const HOST_PENDING: Record<string, string[]> = {};
/** How many kinds may be pending on the Host: the count only goes down. A lane that registers lowers it in the same change; adding a kind to the table or the list without a handler cannot raise it. */
const HOST_PENDING_AT_MOST = 0;

/** The device lanes' kinds nothing registers yet (Google's handlers belong to the device's own composition, which is not wired in everywhere). Shrinks as a composition registers them; never grows. */
const DEVICE_PENDING: Record<string, string[]> = {
  google: Object.entries(INTENT_TABLE)
    .filter(([, e]) => (DEVICE_LANES as readonly string[]).includes(e.lane))
    .map(([kind]) => kind),
};
/** How many device-lane kinds may be pending: the count only goes down, like the Host's. */
const DEVICE_PENDING_AT_MOST = 3;

/** What the Mac's actions do on the client alone (reducer state, not a request to the home). */
const CLIENT_LOCAL = new Set(['setup.next', 'setup.open', 'setup.google', 'setup.notifications', 'home.useOtherAgent']);

const mac = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/components/momo/home/homeActions.ts'), 'utf8');
const actionTypes = [...mac.matchAll(/type: '([A-Za-z.]+)'/g)].map((m) => m[1]!).filter((t, i, all) => all.indexOf(t) === i);

test('the pending list only shrinks: a kind cannot be added to it silently', () => {
  assert.ok(Object.values(HOST_PENDING).flat().length <= HOST_PENDING_AT_MOST, 'HOST_PENDING grew past its baseline');
  // the baseline itself follows the list down, so it never leaves room for an entry to be added later
  assert.equal(Object.values(HOST_PENDING).flat().length, HOST_PENDING_AT_MOST, 'lower HOST_PENDING_AT_MOST to the list’s length');
});

test('the device lanes’ pending list only shrinks too: no kind is filtered out of the both-ways check without being counted', () => {
  const pending = Object.values(DEVICE_PENDING).flat();
  assert.ok(pending.length <= DEVICE_PENDING_AT_MOST, 'DEVICE_PENDING grew past its baseline');
  assert.equal(pending.length, DEVICE_PENDING_AT_MOST, 'lower DEVICE_PENDING_AT_MOST to the list’s length');
  for (const [lane, kinds] of Object.entries(DEVICE_PENDING)) for (const kind of kinds) assert.equal(INTENT_TABLE[kind]?.lane, lane, kind);
  // every device kind of the table is listed: a new one has to be counted here
  const inTable = Object.entries(INTENT_TABLE).filter(([, e]) => (DEVICE_LANES as readonly string[]).includes(e.lane)).length;
  assert.equal(pending.length, inTable);
});

test('every kind has an owning lane and typed arguments', () => {
  for (const [kind, entry] of Object.entries(INTENT_TABLE)) {
    assert.ok((LANES as readonly string[]).includes(entry.lane), `${kind}: lane ${entry.lane}`);
    for (const spec of Object.values(entry.args)) assert.match(spec, /^(string|object|boolean|number)\??$/, kind);
    assert.equal(typeof entry.lease, 'boolean', kind);
  }
});

test('every action the Mac’s screens can take is client-only or an intent kind the table names', () => {
  assert.ok(actionTypes.length > 25, `read ${actionTypes.length} action types`);
  const sent = new Set<string>();
  for (const type of actionTypes) {
    if (CLIENT_LOCAL.has(type) || type === 'intent') continue;
    const kind = toIntent({ type } as any).kind;
    assert.ok(Object.hasOwn(INTENT_TABLE, kind), `the Mac action "${type}" sends "${kind}", which is not in shared/momoIntents.mjs`);
    sent.add(kind);
  }
  assert.ok(sent.has('send') && sent.has('reclaim') && sent.has('task.stop'));
});

/** Each member of the Mac's action union with the fields it declares, as `{ type, fields: [name, tsType][] }` (a member's braces may nest: `Partial<{ ... }>`). */
function members(text: string) {
  const out: { type: string; fields: [string, string][] }[] = [];
  for (const start of text.matchAll(/\{\s*type:\s*'([A-Za-z.]+)'/g)) {
    let depth = 0;
    let end = start.index!;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      if (text[end] === '}' && --depth === 0) break;
    }
    const body = text.slice(start.index! + 1, end);
    const fields: [string, string][] = [];
    // top-level `name: type;` pairs after the type tag
    let level = 0;
    let chunk = '';
    for (const ch of body.replace(/^\s*type:\s*'[A-Za-z.]+'\s*;?/, '')) {
      if ('{<'.includes(ch)) level++;
      if ('}>'.includes(ch)) level--;
      if ((ch === ';' || ch === ',') && level === 0) {
        const m = /^\s*([A-Za-z]+)\s*\??:\s*([\s\S]+)$/.exec(chunk);
        if (m) fields.push([m[1]!, m[2]!.trim()]);
        chunk = '';
      } else chunk += ch;
    }
    const last = /^\s*([A-Za-z]+)\s*\??:\s*([\s\S]+)$/.exec(chunk);
    if (last) fields.push([last[1]!, last[2]!.trim()]);
    out.push({ type: start[1]!, fields });
  }
  return out;
}
/** A value of the declared type, enough for the table's argument check. */
const sample = (ts: string): unknown => {
  if (/^'.*'(\s*\|\s*'.*')*$/.test(ts)) return /'([^']*)'/.exec(ts)![1];
  if (ts === 'string') return 'x';
  if (ts === 'boolean') return true;
  if (ts === 'number') return 1;
  // a named type alias (MomoRuleEffect…) is text on the wire
  if (/^Momo[A-Za-z]+$/.test(ts)) return 'x';
  return {};
};

test('what the Mac’s screens send carries the arguments the table names, by name and type', () => {
  const all = members(mac);
  assert.ok(all.length > 25);
  let checked = 0;
  for (const { type, fields } of all) {
    if (CLIENT_LOCAL.has(type) || type === 'intent') continue;
    const action = { type, ...Object.fromEntries(fields.map(([name, ts]) => [name, sample(ts)])) };
    const intent = toIntent(action as any);
    assert.equal(
      argsFit(intent.kind, intent),
      true,
      `the Mac action "${type}" sends ${JSON.stringify(intent)}, which does not fit the table's arguments for "${intent.kind}"`,
    );
    checked++;
  }
  assert.ok(checked > 25, `checked ${checked} actions`);
});

/**
 * Every implementation of the home API the app can run, each as `{ name, make, exact }`: `make()` returns an object with `pending()` (the table's kinds with no
 * handler, from `createIntentRegistry().pending()`). The scripted home is exact: its pending list is PENDING. The real composition over the Hosts (electron/, the
 * Mac's main process) is added here by the change that makes it, with `exact: false` until every lane has registered on it: it may have registered MORE than the
 * scripted home, never fewer of the home lane's kinds, and never leaves a kind pending that PENDING does not list.
 */
const HOMES: { name: string; make: () => { pending: () => string[] }; exact: boolean }[] = [
  { name: 'the scripted home', make: () => createFakeHome({ stepMs: 0 }), exact: true },
  // the Mac's real composition: the home lane's kinds are its own, every Host lane's are forwarded to the home's Host
  {
    name: 'the real composition over the Hosts',
    make: () =>
      createRealHome({
        hosts: { machines: () => [], call: async () => ({}) },
        outbox: createMomoOutbox({ store: { read: () => [], write: () => undefined }, now: () => 0 }),
        sent: { read: () => [], write: () => undefined },
        report: () => undefined,
      }),
    exact: false,
  },
];

for (const home of HOMES)
  test(`${home.name}: the home lane’s kinds all have handlers, and the other lanes’ are the pending list or fewer; a lane that registered must have left the list`, () => {
    const pending = home.make().pending();
    // the scripted home forwards nothing to a Host: every Host lane's kind is pending on it
    const isDevice = (kind: string) => (DEVICE_LANES as readonly string[]).includes(INTENT_TABLE[kind]!.lane);
    const listed = Object.keys(INTENT_TABLE)
      .filter((k) => INTENT_TABLE[k]!.lane !== 'home' && !isDevice(k))
      .sort();
    // a device lane's handlers (Google's) are registered by the device's own composition: that lane's tests check them
    const hostPending = pending.filter((k) => !isDevice(k));
    if (home.exact) assert.deepEqual(hostPending, listed);
    else
      assert.deepEqual(
        hostPending.filter((k) => !listed.includes(k)),
        [],
        'a kind is pending here that no lane is listed as still owing',
      );
    assert.deepEqual(
      Object.entries(INTENT_TABLE).filter(([kind, e]) => e.lane === 'home' && pending.includes(kind)),
      [],
      'a home-lane kind has no handler',
    );
  });

test('the registry refuses a kind not in the table, another lane’s kind and a second handler, checks the arguments and the lease', async () => {
  let running = false;
  const reg = createIntentRegistry({ running: () => running });
  assert.throws(() => reg.register('home', { nothing: () => 1 }), /not in the table/);
  assert.throws(() => reg.register('gate', { wake: () => 1 }), /belongs to the home lane/);
  reg.register('gate', { 'approval.send': (i: any) => `sent ${i.id}`, 'note.forget': () => 'forgot' });
  assert.throws(() => reg.register('gate', { 'approval.send': () => 1 }), /already has a handler/);
  const run = reg.intents();
  assert.deepEqual(reg.registered(), ['approval.send', 'note.forget']);
  assert.ok(reg.pending().includes('wake'));
  // the arguments are the table's
  for (const bad of [{}, { id: 3 }, { id: null }]) assert.throws(() => run['approval.send']!(bad), /not something MoMo can do/);
  // a kind that acts on the home's data runs only while the home runs here
  assert.throws(() => run['approval.send']!({ id: 'a' }), /isn’t running on this machine/);
  running = true;
  assert.equal(run['approval.send']!({ id: 'a' }), 'sent a');
  assert.equal(argsFit('rule.edit', { id: 'r', text: 't', effect: 'tell_now' }), true);
  assert.equal(argsFit('rule.edit', { id: 'r', text: 't', effect: 'x', inBrief: 'yes' }), false);
  assert.equal(argsFit('settings.set', { settings: [] }), false);
  assert.equal(argsFit('no-such', {}), false);
  assert.equal(argsFit('toString', {}), false);
});

test('stop-turn stops the turn in flight, or a named one, and refuses when there is none', async () => {
  const fake = createFakeHome({ stepMs: 0 });
  assert.equal((await fake.api.intent({ kind: 'stop-turn' })).ok, false);
  await fake.api.intent({ kind: 'send', turnId: 'key-00000001', text: 'go' });
  const stopped: any = await fake.api.intent({ kind: 'stop-turn', turnId: 'key-00000001' });
  assert.equal(stopped.view.chat.find((r: any) => r.id === 'key-00000001').delivery, 'cancelled');
  await fake.api.intent({ kind: 'send', turnId: 'key-00000002', text: 'again' });
  assert.equal((await fake.api.intent({ kind: 'stop-turn' })).ok, true, 'the newest turn still going');
  assert.equal((await fake.api.intent({ kind: 'stop-turn', turnId: 3 })).ok, false, 'a turn id that is not text');
  // and a fix no handler knows is refused with words, not a crash
  assert.equal((await fake.api.intent({ kind: 'fix', id: 'nothing:here' })).ok, false);
  assert.equal((await fake.api.intent({ kind: 'set-up-machine', machineId: 'studio' })).ok, true);
});

test('the Host registers the lanes’ intents from their services: what is still pending there is exactly HOST_PENDING, and every lane in it owns the kinds listed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-intents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions: any = { chats: { records: new Map(), patchMeta: () => undefined }, isolated: () => true, isolate: () => undefined };
  const home: any = momoHomeFor({
    paths: { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') },
    report: () => undefined,
    sessions,
    epochs: { current: () => 1 } as any,
    hidden: createMomoHidden(),
    hostId: 'home-aaaa-1111',
  });
  t.after(() => home.close());
  const registry = home.intentRegistry();
  const hostKinds = Object.entries(INTENT_TABLE).filter(([, e]) => e.lane !== 'home' && !DEVICE_LANES.includes(e.lane));
  const pending = registry
    .pending()
    .filter((k: string) => INTENT_TABLE[k]!.lane !== 'home' && !DEVICE_LANES.includes(INTENT_TABLE[k]!.lane))
    .sort();
  assert.deepEqual(
    pending,
    Object.values(HOST_PENDING).flat().sort(),
    'a lane registered (or a kind is pending) without HOST_PENDING saying so',
  );
  for (const [lane, kinds] of Object.entries(HOST_PENDING)) for (const kind of kinds) assert.equal(INTENT_TABLE[kind]?.lane, lane, kind);
  assert.ok(hostKinds.length > pending.length, 'at least one lane has registered');
  assert.deepEqual(
    registry.registered().filter((k: string) => INTENT_TABLE[k]!.lane === 'home'),
    [],
    'the home lane’s kinds are the Mac’s, never registered on a Host',
  );
});
