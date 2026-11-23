// A site or action card of a chat that runs on a machine says the page is on that machine (F5 of the VM journey), and the lookup main's tables use for the machine's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { siteTables } = require('../electron/app/browserSiteTables.cjs');
const { siteOf } = require('../electron/capabilities/browser/origins.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

function tables(over: { owner?: string; name?: string | null | undefined } = {}) {
  const cards: any[] = [];
  const live: any = {
    sessions: new Map([['c1', { permission: 'default', activeTurn: { id: 't' } }]]),
    controller: { ref: () => ({ kind: 'acp:kimi', id: null }), adapterOf: () => ({}) },
    remoteOwners: { get: () => null },
    hostOwnership: { get: () => ({ hostId: over.owner ?? 'local' }) },
    hostNameOf: () => over.name,
    computerUse: {
      broker: {
        ask: async (_chat: string, kind: string, p: any) => (
          cards.push({ kind, ...p }), { decision: 'allow', scope: 'once', level: 'read' }
        ),
      },
    },
  };
  return { ...siteTables({ live, dir: '/tmp/none', prefs: () => ({}), isFlagEnabled: () => false }), cards };
}
const ctx = { chatId: 'c1', segmentId: 's1' };

test('the site card and the confirmation of a chat on a machine name the machine; a chat on this Mac is as before', async () => {
  const t = tables({ owner: 'ssh:box', name: 'build-box' });
  await t.browserGrants.require('http://localhost:8000/', 'read', ctx);
  await t.browserGrants.act('http://localhost:8000/', ctx, { sensitive: { verb: 'delete' } });
  assert.deepEqual(
    t.cards.map((c: any) => [c.kind, c.onMachine]),
    [
      ['browserOrigin', 'build-box'],
      ['computerConfirm', 'build-box'],
    ],
  );
  // a machine the list no longer holds is still said to be another machine, not left out
  const gone = tables({ owner: 'ssh:gone', name: null });
  await gone.browserGrants.require('http://localhost:8000/', 'read', ctx);
  assert.equal(gone.cards[0].onMachine, 'another machine');
  const mac = tables();
  await mac.browserGrants.require('https://example.test/', 'read', ctx);
  await mac.browserGrants.act('https://example.test/', ctx, { sensitive: { verb: 'delete' } });
  assert.deepEqual(
    mac.cards.map((c: any) => 'onMachine' in c),
    [false, false],
  );
});

test('main answers a machine’s name from its list row, for the cards', () => {
  const live: any = {};
  register(
    { handle: () => undefined },
    { live, app: { getPath: () => os.tmpdir() }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: () => ({ row: (id: string) => (id === 'ssh:box' ? { name: 'build-box' } : undefined) }) as any, allowed: () => true },
  );
  assert.equal(live.hostNameOf('ssh:box'), 'build-box');
  assert.equal(live.hostNameOf('ssh:nobody'), null);
});

test('a tab’s site: its origin, nothing for a tab without a page or a blank one, the address itself for a page that is not a web page', () => {
  assert.equal(siteOf('https://a.test/one#x'), 'https://a.test');
  assert.equal(siteOf(''), '');
  assert.equal(siteOf('about:blank'), '');
  assert.equal(siteOf('chrome://settings'), 'chrome://settings');
});
