// Computer access (#1364): a remote owner is never a chat here. It runs at most at `auto` (never Full), gets none of the
// global "Always allow" apps or sites and adds none, keeps its grants only as long as it lives, and when it goes away
// its turn ends as a chat's does. Its stop goes to its device, never to a chat on this Mac.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { RemoteOwners, remoteAnchor } = require('../electron/computerAccess/owners.cjs');
const { GrantStore } = require('../electron/capabilities/grants.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { chatAnchorOf } = require('../electron/capabilities/anchor.cjs');
const { setupComputerUse } = require('../electron/capabilities/computerUse.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { createComputerAccess, stopOwnerOrChat, usesSavedSites } = require('../electron/app/computerAccess.cjs');

const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-remote-owner-'));
  dirs.push(d);
  return d;
};
const NOTES = { bundleId: 'com.apple.Notes', name: 'Notes' };
const SITE = 'https://shop.example';

/** An owner for a device's chat, as the host enters one for a call. */
function owner(owners: any, o: any = {}) {
  return owners.enter({ deviceId: 'dev1', deviceName: 'Du’s MacBook', clientChat: 'chat-1', hostAnchor: 'full', ...o });
}

test('a remote owner runs under the stricter of its chat and this Mac, and never above Ask (every site asks)', () => {
  assert.equal(remoteAnchor('full', 'full'), 'ask');
  assert.equal(remoteAnchor('full', 'ask'), 'ask');
  assert.equal(remoteAnchor('auto', 'full'), 'ask');
  assert.equal(remoteAnchor('readOnly', 'full'), 'readOnly');
  assert.equal(remoteAnchor('ask', 'readOnly'), 'readOnly');
  // a mode nobody knows reads as ask, on either side
  assert.equal(remoteAnchor('bypass-everything', 'full'), 'ask');
  assert.equal(remoteAnchor(undefined, null), 'ask');
  // either side may be a permission mode rather than an anchor: a read-only Mac caps an owner at read only
  assert.equal(remoteAnchor('full-access', 'read-only'), 'readOnly');
  assert.equal(remoteAnchor('bypassPermissions', 'full-access'), 'ask');
  assert.equal(remoteAnchor('acceptEdits', 'full-access'), 'ask');
});

test('owners: one per device chat, ids that keep delimiters apart, and what the client says is cut to size', () => {
  const owners = new RemoteOwners();
  const a = owner(owners, { harness: 'claude', model: 'claude-sonnet-5-5', anchor: 'auto', human: true, hostOnlyApprovals: true });
  assert.equal(a.id, RemoteOwners.idOf('dev1', 'chat-1'));
  assert.equal(a.anchor, 'ask');
  assert.equal(a.human, true);
  assert.equal(a.hostOnlyApprovals, true);
  assert.equal(owners.get(a.id), a);
  // ids that would collide if joined with a separator stay apart (I1)
  assert.notEqual(RemoteOwners.idOf('a","b', 'c'), RemoteOwners.idOf('a', 'b","c'));
  // entering again keeps what was granted and takes the client's new facts
  a.appGrants.push({ bundleId: NOTES.bundleId, name: 'Notes', level: 'click', at: 1 });
  const again = owner(owners, { harness: 'x'.repeat(100), model: 'm'.repeat(200), anchor: 'readOnly' });
  assert.equal(again.appGrants.length, 1);
  assert.equal(again.harness.length, 40);
  assert.equal(again.model.length, 120);
  assert.equal(again.anchor, 'readOnly');
  assert.equal(again.human, false);
  const bare = owner(owners, { clientChat: 'chat-2', harness: '', model: 7 });
  assert.equal(bare.harness, 'remote');
  assert.equal(bare.model, null);
  assert.equal(owners.get('chat-1'), null);
  assert.equal(owners.get(42), null);
  assert.equal(owners.list().length, 2);
  owner(owners, { deviceId: 'dev2', clientChat: 'chat-1' });
  assert.equal(owners.ofDevice('dev1').length, 2);
});

test('owners: closing one, a device or all tells every listener, even after one fails', () => {
  const owners = new RemoteOwners();
  const closed: string[] = [];
  owners.onClose(() => {
    throw new Error('listener broke');
  });
  const stopListening = owners.onClose((o: any, why: string) => closed.push(`${o.clientChat}@${o.deviceId}:${why}`));
  owner(owners);
  owner(owners, { clientChat: 'chat-2' });
  owner(owners, { deviceId: 'dev2' });
  assert.equal(owners.close(RemoteOwners.idOf('dev2', 'chat-1'), 'turn'), true);
  assert.equal(owners.close('nope', 'turn'), false);
  assert.equal(owners.closeDevice('dev1', 'revoked'), 2);
  assert.deepEqual(closed, ['chat-1@dev2:turn', 'chat-1@dev1:revoked', 'chat-2@dev1:revoked']);
  owner(owners);
  owner(owners, { deviceId: 'dev3' });
  assert.equal(owners.closeAll('off'), 2);
  assert.equal(owners.list().length, 0);
  stopListening();
  owner(owners);
  owners.closeAll('off');
  assert.equal(closed.length, 5);
  const opened: string[] = [];
  owners.onOpen(() => {
    throw new Error('listener broke');
  });
  const stopOpen = owners.onOpen((o: any) => opened.push(o.clientChat));
  owner(owners);
  owner(owners);
  stopOpen();
  owner(owners, { clientChat: 'chat-9' });
  assert.deepEqual(opened, ['chat-1']);
});

test('owners: a stop tells the device and closes the owner, whether the device answers, fails or there is none', async () => {
  const owners = new RemoteOwners();
  const told: string[] = [];
  const a = owner(owners);
  assert.equal(await owners.stop(a.id), true);
  assert.equal(owners.get(a.id), null);
  owners.setStopper(async (o: any) => void told.push(o.clientChat));
  const b = owner(owners);
  await owners.stop(b.id);
  owners.setStopper(async () => {
    throw new Error('device gone');
  });
  const c = owner(owners, { clientChat: 'chat-3' });
  assert.equal(await owners.stop(c.id), true);
  assert.equal(owners.get(c.id), null);
  assert.equal(await owners.stop('nope'), false);
  assert.deepEqual(told, ['chat-1']);
});

test('apps: a remote owner gets no "Always allow" app, never writes the global list or a chat, and its grants go with it', () => {
  const dir = tmp();
  const owners = new RemoteOwners();
  const patched: string[] = [];
  const changed: (string | null)[] = [];
  const g = new GrantStore({
    file: path.join(dir, 'computer.json'),
    chats: { get: () => null, patchMeta: (id: string) => (patched.push(id), true) },
    remote: owners,
    onChange: (c: string | null) => changed.push(c),
  });
  g.grant(null, { bundleId: 'com.apple.TextEdit', name: 'TextEdit' }, 'full', 'always');
  const o = owner(owners);
  assert.deepEqual(g.forChat(o.id), []);
  assert.equal(g.forChat('local-chat').length, 1);
  // an "always" answer on a remote card lasts as long as the owner, never on the global list
  assert.equal(g.grant(o.id, NOTES, 'click', 'always'), true);
  assert.equal(g.grant(o.id, NOTES, 'view', 'chat'), true);
  assert.equal(g.grant(o.id, NOTES, 'full', 'once'), false);
  assert.deepEqual(
    g.forChat(o.id).map((x: any) => [x.bundleId, x.level]),
    [[NOTES.bundleId, 'click']],
  );
  assert.deepEqual(g.chat(o.id).length, 1);
  assert.equal(g.global().length, 1);
  assert.deepEqual(patched, []);
  assert.equal(g.revoke(o.id, NOTES.bundleId), true);
  assert.equal(g.revoke(o.id, NOTES.bundleId), false);
  assert.deepEqual(g.forChat(o.id), []);
  assert.deepEqual(changed.filter((c) => c === o.id).length, 3);
});

test('sites: a remote owner gets no saved site, its card offers no "Always", and its answer saves nothing for good', async () => {
  const owners = new RemoteOwners();
  const o = owner(owners);
  const asked: any[] = [];
  const grants = new OriginGrants({
    anchor: () => 'ask',
    ask: async (q: any) => (asked.push(q), { decision: 'allow', scope: 'always', level: 'write' }),
    usesSaved: (id: string) => !owners.get(id),
  });
  grants.set(SITE, 'write');
  const local = { chatId: 'local', segmentId: 's' };
  const remote = { chatId: o.id, segmentId: o.id };
  await grants.require(SITE, 'write', local);
  assert.equal(asked.length, 0);
  assert.equal(grants.peek(SITE, 'write', local), 'ok');
  assert.equal(grants.peek(SITE, 'write', remote), 'ask');
  await grants.require(`${SITE}/cart`, 'write', remote);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].allowAlways, false);
  // the answer counts for the owner only, and the saved table is unchanged
  await grants.require('https://other.example/', 'write', remote);
  assert.equal(grants.get('https://other.example'), null);
  assert.equal(grants.peek('https://other.example/', 'write', remote), 'ok');
  grants.forget(o.id);
  assert.equal(grants.peek('https://other.example/', 'write', remote), 'ask');
  // a consent recorded for an owner (as the Codex plugin's is) keeps an "always" for the owner, never for good
  assert.equal(grants.consented(o.id, 'https://plugin.example', 'always'), true);
  assert.equal(grants.get('https://plugin.example'), null);
  assert.equal(grants.peek('https://plugin.example/', 'write', remote), 'ok');
  assert.equal(grants.consented('local', 'https://plugin.example', 'always'), true);
  assert.equal(grants.get('https://plugin.example'), 'write');
  // every chat gets the saved table when nobody says otherwise
  assert.equal(new OriginGrants({ ask: async () => null }).usesSaved('x'), true);
});

test('anchor: a remote owner reads its own anchor; a chat reads its mode as before', () => {
  const owners = new RemoteOwners();
  const o = owner(owners, { anchor: 'full' });
  const deps = {
    sessions: { get: () => ({ permission: 'full-access' }) },
    controller: { ref: () => ({ kind: 'codex' }) },
    prefs: () => ({ permission: 'full-access' }),
    remote: owners,
  };
  assert.equal(chatAnchorOf(o.id, deps), 'ask');
  assert.equal(chatAnchorOf('local', deps), 'full');
  assert.equal(chatAnchorOf('local', { ...deps, remote: undefined }), 'full');
});

test('computer use: a remote owner is described by its client chat and gets its grants, not a chat record here', async () => {
  const dir = tmp();
  const owners = new RemoteOwners();
  const o = owner(owners, { harness: 'acp:opencode', model: 'claude-sonnet-5-5', anchor: 'ask' });
  const records: string[] = [];
  const runtime = setupComputerUse({
    ipcMain: { handle: () => {} },
    registry: new Registry(),
    flags: { isEnabled: () => true },
    chats: { get: () => null, patchMeta: () => true, record: (id: string) => (records.push(id), { segments: [] }) },
    controller: { ref: () => ({ kind: 'codex' }), chatOf: (id: string) => id, isSubagentCall: () => false, viewing: () => false },
    sessions: { get: () => ({ activeTurn: { id: 't', human: true } }), patch: () => {} },
    remote: owners,
    prefs: () => ({}),
    userData: dir,
    packaged: false,
    broadcast: () => {},
    stop: async () => {},
  });
  assert.equal(runtime.cu.harness(o.id), 'acp:opencode');
  assert.equal(runtime.cu.harness('local'), 'codex');
  assert.equal(runtime.cu.anchor(o.id), 'ask');
  assert.equal(await runtime.desktop.modelOf(o.id), 'claude-sonnet-5-5');
  await runtime.desktop.modelOf('local');
  assert.deepEqual(records, ['local']);
  runtime.grants.grant(o.id, NOTES, 'click', 'chat');
  assert.equal(runtime.grants.forChat(o.id).length, 1);
  // the owner's turn is attended when a person started it on the client: this Mac sitting idle for an hour (its person
  // is at the device) does not make it unattended, while a chat here would be
  runtime.helper.idleSeconds = async () => 3600;
  assert.equal(await runtime.cu.unattended(o.id), null);
  assert.equal(await runtime.cu.unattended('local'), 'no input for 10 minutes');
  runtime.cu.close?.();
  // without computer access wired in, a chat's model comes from its record as before
  const plain = setupComputerUse({
    ipcMain: { handle: () => {} },
    registry: new Registry(),
    flags: { isEnabled: () => true },
    // a chat store without lazy records (as some tests and early startup have)
    chats: { get: () => null, patchMeta: () => true },
    controller: { ref: () => ({ kind: 'codex' }), chatOf: (id: string) => id, isSubagentCall: () => false, viewing: () => false },
    sessions: { get: () => ({}), patch: () => {} },
    userData: tmp(),
    packaged: false,
    broadcast: () => {},
    stop: async () => {},
  });
  // the overlay names a remote owner's device; a chat here (or no computer access at all) names its agent, as the pill does
  assert.equal(runtime.indicator.labelFor(o.id), 'Du’s MacBook is using your computer · Esc to stop');
  assert.equal(runtime.indicator.labelFor('local'), 'The agent is using your computer · Esc to stop');
  assert.equal(plain.indicator.labelFor('local'), 'The agent is using your computer · Esc to stop');
  await plain.desktop.modelOf('another');
  assert.deepEqual(records, ['local']);
});

test('main: an owner that goes away forgets its site answers, and a new one starts clean', () => {
  const forgot: string[] = [];
  const live: any = {
    browserGrants: { forget: (id: string) => forgot.push(`iab:${id}`) },
    chromeGrants: { forget: (id: string) => forgot.push(`chrome:${id}`) },
  };
  const { owners } = createComputerAccess({ live });
  const a = owner(owners);
  // a new owner starts clean (what a card withdrawn at an earlier close recorded is gone); entering again keeps it
  assert.deepEqual(forgot, [`iab:${a.id}`, `chrome:${a.id}`]);
  owner(owners);
  assert.equal(forgot.length, 2);
  forgot.length = 0;
  owners.close(a.id, 'turn');
  assert.deepEqual(forgot, [`iab:${a.id}`, `chrome:${a.id}`]);
  // services not up yet are skipped
  const bare = createComputerAccess({ live: {} });
  const c = owner(bare.owners);
  assert.equal(bare.owners.close(c.id, 'turn'), true);
});

test('main: Esc and the tray stop a remote owner through its device, and a chat as before; owners skip saved sites', async () => {
  const owners = new RemoteOwners();
  const stopped: string[] = [];
  owners.setStopper((o: any) => void stopped.push(`device:${o.clientChat}`));
  const live: any = { remoteOwners: owners, controller: { stopChat: async (id: string) => void stopped.push(`chat:${id}`) } };
  const stop = stopOwnerOrChat(live);
  const o = owner(owners);
  await stop(o.id);
  await stop('local');
  assert.deepEqual(stopped, ['device:chat-1', 'chat:local']);
  const uses = usesSavedSites(live);
  const p = owner(owners);
  assert.equal(uses(p.id), false);
  assert.equal(uses('local'), true);
  assert.equal(usesSavedSites({})('local'), true);
});
