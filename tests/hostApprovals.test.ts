// What a person approved on each Host (electron/capabilities/hostApprovals.cjs, hostGrants.cjs): listed under the machine's name, taken back, kept apart per machine, and gone with a machine that was removed. The phone's card names the machine too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHostApprovals } = require('../electron/capabilities/hostApprovals.cjs');
const { hostGrantStore, hostsWithGrants, removeHostGrants } = require('../electron/capabilities/hostGrants.cjs');
const { hostCard } = require('../electron/capabilities/browser/chromePanelHostCard.cjs');
const { cardOf } = require('../electron/capabilities/browser/chromePanelCards.cjs');

const NOTES = { bundleId: 'com.apple.Notes', name: 'Notes' };

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-approvals-'));
  const stores = new Map<string, any>();
  const grantsFor = (id: string) => (stores.has(id) || stores.set(id, hostGrantStore({ dir, hostId: id })), stores.get(id));
  const names: Record<string, string> = { h1: 'box', h2: 'studio' };
  const forgotten: string[] = [];
  const a = createHostApprovals({
    grantsFor,
    nameOf: (id: string) => names[id],
    knownHosts: () => hostsWithGrants(dir),
    forget: (id: string) => {
      forgotten.push(id);
      stores.delete(id);
      removeHostGrants(dir, id);
    },
  });
  return { dir, a, grantsFor, forgotten };
}

test('approvals are listed under each machine and never mix: an app allowed on one machine is not on the other', () => {
  const w = world();
  w.grantsFor('h1').grant('c1', NOTES, 'click', 'chat');
  w.grantsFor('h2').grant('c2', { bundleId: 'com.apple.Safari', name: 'Safari' }, 'view', 'chat');
  const out = w.a.settings();
  assert.deepEqual(
    out.map((m: any) => [m.name, m.chats.map((c: any) => [c.chatId, c.grants.map((g: any) => g.bundleId)])]),
    [
      ['box', [['c1', ['com.apple.Notes']]]],
      ['studio', [['c2', ['com.apple.Safari']]]],
    ],
  );
});

test('a chat that moved to another machine still shows its approvals on the machine that holds them, and can be taken back', () => {
  const w = world();
  w.grantsFor('h1').grant('c1', NOTES, 'click', 'chat');
  // c1 now lives on another machine (or on this Mac): the machine that holds its approvals still lists them
  const moved = createHostApprovals({ grantsFor: w.grantsFor, nameOf: () => 'box', knownHosts: () => ['h1'] });
  const [m] = moved.settings();
  assert.deepEqual(
    m.chats.map((c: any) => c.chatId),
    ['c1'],
  );
  assert.equal(moved.revoke('h1', 'c1', NOTES.bundleId), true);
});

test('Remove takes one app back from its machine only; Remove all empties a machine’s always-allowed list', () => {
  const w = world();
  w.grantsFor('h1').grant('c1', NOTES, 'click', 'chat');
  w.grantsFor('h1').grant('c1', NOTES, 'click', 'always');
  assert.equal(w.a.revoke('h1', 'c1', NOTES.bundleId), true);
  assert.equal(w.a.revoke('h2', 'c1', NOTES.bundleId), false, 'another machine holds nothing of it');
  assert.equal(w.grantsFor('h1').chat('c1').length, 0);
  assert.equal(w.grantsFor('h1').global().length, 1);
  assert.equal(w.a.revokeAll('h1'), true);
  assert.deepEqual(w.a.settings(), []);
});

test('a machine that is no longer in the app takes its approvals with it; the ones still there keep theirs', () => {
  const w = world();
  w.grantsFor('h1').grant('c1', NOTES, 'click', 'chat');
  w.grantsFor('h2').grant('c2', NOTES, 'click', 'chat');
  w.a.sweep(new Set(['h2']));
  assert.deepEqual(w.forgotten, ['h1']);
  assert.deepEqual(hostsWithGrants(w.dir), ['h2']);
  assert.equal(w.grantsFor('h1').chat('c1').length, 0, 'added again later: it starts with none');
  assert.equal(w.grantsFor('h2').chat('c2').length, 1);
});

test('a phone’s card for a chat on a Host names the machine; one for this Mac does not', () => {
  const ask = { kind: 'computerAccessSet', apps: [{ name: 'Notes', tier: 'click' }], machine: 'box' };
  assert.match(hostCard(ask, 'Claude Code').title, /Allow Claude Code to use these apps on box\?/);
  assert.doesNotMatch(hostCard({ ...ask, machine: undefined }, 'Claude Code').title, / on /);
  assert.match(hostCard({ kind: 'computerAccess', app: NOTES, level: 'click', machine: 'box' }, 'Claude Code').title, / on box\?/);
});

test('the card a phone is shown for a Host chat is built by the panel’s own path (cardOf -> hostCard) and says the machine', () => {
  const access = { id: 'a1', method: 'sage/computerAccess', params: { kind: 'computerAccess', app: NOTES, machine: 'box' } };
  assert.equal(cardOf(access, 'Claude Code').title, 'Allow Claude Code to use Notes on box?');
  assert.equal(
    cardOf({ ...access, params: { ...access.params, machine: undefined } }, 'Claude Code').title,
    'Allow Claude Code to use Notes?',
  );
  const set = { id: 'a2', method: 'sage/computerAccessSet', params: { kind: 'computerAccessSet', apps: [], machine: 'box' } };
  assert.match(cardOf(set, 'Claude Code').title, /Allow Claude Code to use these apps on box\?/);
});

test('a card for a chat on a paired computer names it by its host when it has no name', () => {
  const ask = { kind: 'computerAccess', app: NOTES, remote: { host: 'mini' } };
  assert.match(hostCard(ask, 'Claude Code').title, /Allow Claude Code to use Notes on mini\?/);
  assert.match(hostCard({ ...ask, remote: { host: 'mini', hostName: 'Studio' } }, 'Claude Code').title, / on Studio\?/);
});
