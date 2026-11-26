// "Allow connections" on the controlled Host (R2b of #5576): the app's switch, told over the CLI connection (`host.codePair.connections`), kept in the config folder (host/src/codePairWiring.mjs) and read at each offer, closed when never told or unreadable; off ends every open offer (host/src/codePairService.mjs); the method is the CLI's only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { codePairFor, connectionsOf } from '../host/src/codePairWiring.mjs';
// @ts-ignore
import methodsOf from '../host/src/methods/codePair.mjs';
// @ts-ignore
import { parseParams, helloParams } from '../shared/host/schema.mjs';
// @ts-ignore
import { kindAllows } from '../host/src/controllerRefusals.mjs';
import { OFFER, flush, world } from './support/host/codePairWorld.ts';
import { servedHost } from './support/hostClientsWorld.ts';

const dirOf = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'code-pair-conn-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('the Host keeps what the app says in its config folder, owner-only, and reads it each time; never told, missing or unreadable is closed', (t) => {
  const dir = path.join(dirOf(t), 'config');
  const c = connectionsOf(dir);
  assert.equal(c.open(), false, 'a Host the app never told makes no code');
  c.set(true);
  const file = path.join(dir, 'connections.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(c.open(), true);
  assert.equal(connectionsOf(dir).open(), true, 'a Host that restarts keeps it');
  c.set(false);
  assert.equal(c.open(), false);
  assert.equal(connectionsOf(dir).open(), false);
  for (const junk of ['not json', 'null', '{"open":"yes"}', '{"open":1}', '[]']) {
    fs.writeFileSync(file, junk);
    assert.equal(connectionsOf(dir).open(), false, junk);
    assert.equal(connectionsOf(dir).app(), '', `${junk}: no client is exempt`);
  }
  // this app's own key is kept beside the switch; none told, or one that is not a fingerprint, exempts nobody
  const fp = 'c'.repeat(64);
  c.set(false, fp);
  assert.deepEqual([c.open(), c.app()], [false, fp]);
  assert.equal(connectionsOf(dir).app(), fp, 'kept across a restart');
  c.set(false);
  assert.equal(c.app(), '');
  for (const app of [7, 'C'.repeat(64), 'c'.repeat(63)]) {
    fs.writeFileSync(file, JSON.stringify({ open: true, app }));
    assert.equal(connectionsOf(dir).app(), '', String(app));
  }
  fs.writeFileSync(file, '{"open":true}');
  assert.equal(connectionsOf(dir).open(), true, 'read at each offer: a change of the file is seen');
  fs.rmSync(file);
  assert.equal(c.open(), false);
  // a leftover from a write that stopped half way is replaced, not appended to
  fs.writeFileSync(`${file}.tmp`, 'junk', { mode: 0o644 });
  c.set(true);
  assert.equal(c.open(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('an off that cannot be written is still off here, and the file that said open is removed; an on that cannot be written throws and stays closed', (t) => {
  const dir = path.join(dirOf(t), 'config');
  const c = connectionsOf(dir);
  c.set(true);
  const file = path.join(dir, 'connections.json');
  // the temporary file's place is taken by a folder: no write can land
  fs.mkdirSync(`${file}.tmp`);
  fs.writeFileSync(path.join(`${file}.tmp`, 'x'), 'x');
  assert.throws(() => c.set(false));
  assert.equal(c.open(), false, 'off in this process');
  assert.equal(fs.existsSync(file), false, 'and after a restart (the file is gone)');
  assert.throws(() => c.set(true));
  assert.equal(c.open(), false, 'an on that was not kept is not on');
  fs.rmSync(`${file}.tmp`, { recursive: true });
  c.set(true);
  assert.equal(c.open(), true, 'a write that works again opens it');
  // the file cannot be removed either (its folder is where the config folder should be): the process alone keeps it closed
  const parent = dirOf(t);
  const asFile = path.join(parent, 'config');
  fs.writeFileSync(asFile, 'not a folder');
  const d = connectionsOf(asFile);
  assert.throws(() => d.set(false));
  assert.equal(d.open(), false);
});

test('with the flag on the service reads the kept switch: no code before the app said on, a code after, none after off', async (t) => {
  const dir = dirOf(t);
  const p: any = {
    env: { MOPILOT_HOST_CODE_PAIR: '1' },
    paths: { dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') },
    relayLinks: {
      enroll: () => ({}),
      forget: () => undefined,
      retire: () => undefined,
      retireLive: () => undefined,
      onTombstone: () => undefined,
      close: () => undefined,
    },
    pairing: {
      add: () => 'fp',
      remove: () => true,
      onForgotten: () => undefined,
      hostId: () => 'host-h',
      controllerRecords: () => 0,
      believeControllers: () => undefined,
      admitClients: () => undefined,
      admitChanged: () => undefined,
    },
    policy: { allowsClient: () => true },
    audit: { note: () => undefined },
    report: () => undefined,
  };
  const service: any = codePairFor(p);
  const who = { owner: new Set(), emit: () => undefined };
  await assert.rejects(service.offer(OFFER, who), { code: 'connections_off' });
  assert.deepEqual(service.connections({ open: true }), { open: true, cancelled: 0 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config', 'connections.json'), 'utf8')).open, true);
  // past the switch: the next check is the approval helper's (none is enrolled in this world)
  await assert.rejects(service.offer(OFFER, who), (e: any) => e.code !== 'connections_off');
  assert.deepEqual(service.connections({ open: false }), { open: false, cancelled: 0 });
  await assert.rejects(service.offer(OFFER, who), { code: 'connections_off' });
});

test('off ends every open offer at once, whoever made it, the relay told; on ends none; the answer says how many', async (t) => {
  const w = world(t);
  const other = { owner: new Set<() => void>(), emit: (m: any) => w.events.push(m), ends: new Set<() => void>() };
  await w.service.offer(OFFER, w.who);
  await w.service.offer(OFFER, other);
  assert.deepEqual(w.service.connections({ open: true }), { open: true, cancelled: 0 });
  assert.equal(w.service.open(), 2);
  assert.deepEqual(w.service.connections({ open: false }), { open: false, cancelled: 2 });
  assert.equal(w.service.open(), 0);
  assert.deepEqual(
    w.events.slice(-2).map((e) => [e.phase, e.code]),
    [
      ['cancelled', 'connections_off'],
      ['cancelled', 'connections_off'],
    ],
  );
  assert.equal(w.relayCalls.filter((c) => c === 'close').length, 2);
  await assert.rejects(w.service.offer(OFFER, w.who), { code: 'connections_off' });
});

test("off while the person's proof is awaited ends the pairing: nothing is enrolled, no controller is added", async (t) => {
  let release: (v: boolean) => void = () => undefined;
  const w = world(t, { verify: () => new Promise<boolean>((resolve) => (release = resolve)) });
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  await w.toConfirm(code);
  const answering = w.accept(offerId, w.who);
  await flush();
  assert.deepEqual(w.service.connections({ open: false }), { open: false, cancelled: 1 });
  release(true);
  assert.deepEqual(await answering, { accepted: false });
  assert.deepEqual(w.enrolled, []);
  assert.deepEqual(
    w.pairing.list().filter((c: any) => c.kind === 'controller'),
    [],
  );
  assert.equal(w.phases().at(-1), 'cancelled');
});

test('an answer that lands after the switch went off (its file changed under the offer) is a no: the other Mac is denied, nothing enrolled or added', async (t) => {
  let release: (v: boolean) => void = () => undefined;
  const w = world(t, { verify: () => new Promise<boolean>((resolve) => (release = resolve)) });
  const { offerId, code } = await w.service.offer(OFFER, w.who);
  const x = await w.toConfirm(code);
  const answering = w.accept(offerId, w.who);
  await flush();
  w.flags.open = false;
  release(true);
  assert.deepEqual(await answering, { accepted: false });
  assert.deepEqual([w.enrolled, w.forgot], [[], []]);
  assert.deepEqual(
    w.pairing.list().filter((c: any) => c.kind === 'controller'),
    [],
  );
  assert.deepEqual([w.events.at(-1).phase, w.events.at(-1).code], ['failed', 'connections_off']);
  assert.equal(x.a.finish(x.read().messages.at(-1)!.box).denied, true, 'the other Mac is told no');
});

test('an off that could not be kept still ends the offers and refuses new ones; the caller is told it was not kept', async (t) => {
  const w = world(t);
  await w.service.offer(OFFER, w.who);
  w.flags.saveFails = true;
  assert.throws(
    () => w.service.connections({ open: false }),
    (e: any) => e.code === 'not_saved' && /disk full/.test(e.message),
  );
  assert.equal(w.service.open(), 0);
  await assert.rejects(w.service.offer(OFFER, w.who), { code: 'connections_off' });
  assert.throws(() => w.service.connections({ open: true }), { code: 'not_saved' });
  await assert.rejects(w.service.offer(OFFER, w.who), { code: 'connections_off' });
});

test("the request says on or off and nothing else; the handler is the CLI's only, veiled to every other kind, and denied to a controller by the table", () => {
  assert.deepEqual(parseParams('host.codePair.connections', { open: true }), { open: true });
  assert.deepEqual(parseParams('host.codePair.connections', { open: false, extra: 1 }), { open: false });
  const fp = 'd'.repeat(64);
  assert.deepEqual(parseParams('host.codePair.connections', { open: false, app: fp }), { open: false, app: fp });
  assert.deepEqual(parseParams('host.codePair.connections', { open: false, app: null }), { open: false });
  for (const bad of [
    {},
    { open: 'true' },
    { open: 1 },
    { open: null },
    { open: true, app: 'x' },
    { open: true, app: 5 },
    { open: true, app: 'D'.repeat(64) },
  ])
    assert.throws(() => parseParams('host.codePair.connections', bad), { code: 'invalid' }, JSON.stringify(bad));
  const calls: any[] = [];
  const { handlers, veils } = methodsOf({ codePair: { connections: (p: any) => (calls.push(p), { open: p.open, cancelled: 0 }) } as any });
  assert.deepEqual(handlers['host.codePair.connections']({ open: true }, 'cli'), { open: true, cancelled: 0 });
  assert.deepEqual(calls, [{ open: true }]);
  for (const kind of ['desktop', 'phone', 'controller', 'home', 'unknown', undefined])
    assert.throws(() => handlers['host.codePair.connections']({ open: false }, kind), { code: 'unsupported' }, String(kind));
  assert.equal(veils['host.codePair.connections']({ kind: 'cli' }), true);
  assert.equal(veils['host.codePair.connections']({ kind: 'desktop' }), false);
  assert.equal(veils['host.codePair.connections'](null), false);
  assert.throws(() => methodsOf({}).handlers['host.codePair.connections']({ open: true }, 'cli'), { code: 'unsupported' });
  for (const kind of ['controller', 'phone', 'home', 'unknown']) assert.equal(kindAllows(kind, 'host.codePair.connections'), false, kind);
});

test('on a served Host the CLI sets it over its own connection and a paired desktop cannot reach it', async (t) => {
  const told: any[] = [];
  const w = await servedHost(t, { codePair: { connections: (p: any) => (told.push(p), { open: p.open, cancelled: 0 }) } });
  const token = fs.readFileSync(`${w.paths.socketPath}.token`, 'utf8');
  const cli = w.line();
  await cli.call('host.hello', helloParams(), token);
  assert.deepEqual((await cli.call('host.codePair.connections', { open: false }, token)).result, { open: false, cancelled: 0 });
  cli.close();
  assert.deepEqual(told, [{ open: false }]);
  const desk = await w.paired('desk', 'Desk');
  await desk.conn.call('host.hello', helloParams());
  const refused = await desk.conn.call('host.codePair.connections', { open: true });
  assert.match(String(refused.error), /Unknown request: host\.codePair\.connections/);
  assert.deepEqual(told, [{ open: false }]);
});
