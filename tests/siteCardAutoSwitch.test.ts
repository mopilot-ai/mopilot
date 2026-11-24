// "Allow and switch to Auto" on a site card (#1523), main's half: the step is allowed once, and the chat's ordinary sites
// count as Auto in both browsers until its turn ends; read only, sensitive actions, high-risk sites and remote owners keep asking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { siteTables } = require('../electron/app/browserSiteTables.cjs');
const { onThisMac } = require('../electron/capabilities/contract/thisMacControl.cjs');

function tables({ then = 'auto' as string | null, remote = false } = {}) {
  const sessions = new Map<string, any>([['c1', { permission: 'default', activeTurn: { id: 't' } }]]);
  const asked: string[] = [];
  const confirmed: string[] = [];
  const live: any = {
    sessions,
    controller: { ref: () => ({ kind: 'codex', id: null }), adapterOf: () => ({}) },
    remoteOwners: { get: () => (remote ? { anchor: 'ask' } : null) },
    computerUse: {
      broker: {
        ask: async (_chat: string, kind: string, p: any) => {
          if (kind === 'computerConfirm') return confirmed.push(p.app.name), { decision: 'allow' };
          asked.push(p.origin);
          return { decision: 'allow', scope: 'chat', level: 'write', ...(then ? { then } : {}) };
        },
      },
    },
  };
  const t = siteTables({ live, dir: '/tmp/none', prefs: () => ({}), isFlagEnabled: () => false });
  return { ...t, sessions, asked, confirmed };
}
const ctx = { chatId: 'c1', segmentId: 's1' };

test('Allow and switch to Auto: the step once, then no card for ordinary sites in either browser until the turn ends', async () => {
  const t = tables();
  await t.browserGrants.require('https://a.test/', 'write', ctx);
  await t.browserGrants.require('https://b.test/', 'write', ctx);
  await t.chromeGrants.require('https://c.test/', 'write', ctx);
  assert.deepEqual(t.asked, ['https://a.test']);
  // nothing was saved for the chat: the answer counted once
  assert.equal(t.browserGrants.chatGrants.get('c1')?.get('https://a.test'), undefined);
  // a sensitive action still confirms, as in Auto
  await t.browserGrants.act('https://b.test/', ctx, { sensitive: { verb: 'delete' } });
  assert.deepEqual(t.confirmed, ['https://b.test']);
  // another chat is not lifted
  await t.browserGrants.require('https://e.test/', 'write', { chatId: 'c2', segmentId: 's' });
  assert.deepEqual(t.asked, ['https://a.test', 'https://e.test']);
  // the turn ends: the chat's own mode decides again
  t.browserGrants.turnEnded('c1');
  await t.browserGrants.require('https://a.test/', 'write', ctx);
  assert.deepEqual(t.asked, ['https://a.test', 'https://e.test', 'https://a.test']);
});

test('a stricter mode wins over the switch: read only still refuses a write this turn', async () => {
  const t = tables();
  await t.browserGrants.require('https://a.test/', 'read', ctx);
  t.sessions.set('c1', { permission: 'read-only', activeTurn: { id: 't' } });
  await assert.rejects(t.browserGrants.require('https://b.test/', 'write', ctx), { code: 'read_only' });
});

test('an answer without the switch keeps its scope, and a remote owner of computer access is never lifted above Ask', async () => {
  let t = tables({ then: null });
  await t.browserGrants.require('https://a.test/', 'write', ctx);
  await t.browserGrants.require('https://b.test/', 'write', ctx);
  assert.deepEqual(t.asked, ['https://a.test', 'https://b.test']);
  assert.equal(t.browserGrants.chatGrants.get('c1')?.get('https://a.test'), 'write');
  t = tables({ remote: true });
  await t.browserGrants.require('https://a.test/', 'write', ctx);
  await t.browserGrants.require('https://b.test/', 'write', ctx);
  assert.deepEqual(t.asked, ['https://a.test', 'https://b.test']);
});

test('Remote Run Chrome calls use the Mac’s site prompts even if the chat is in Auto or the site has a saved grant', async () => {
  const t = tables();
  await t.browserGrants.require('https://auto.test/', 'write', ctx);
  // Set the in-memory table directly so this test does not write site rules to disk.
  t.chromeGrants.grants.set('https://saved.test', 'write');
  await onThisMac('c1', 'chrome_navigate', async () => {
    await t.chromeGrants.require('https://saved.test/', 'read', ctx);
    t.sessions.set('c1', { permission: 'full-access', activeTurn: { id: 't' } });
    await t.chromeGrants.require('https://one.test/', 'write', ctx);
    await t.chromeGrants.require('https://two.test/', 'write', ctx);
    t.sessions.set('c1', { permission: 'read-only', activeTurn: { id: 't' } });
    await assert.rejects(t.chromeGrants.require('https://three.test/', 'write', ctx), { code: 'read_only' });
  });
  assert.deepEqual(t.asked, ['https://auto.test', 'https://saved.test', 'https://one.test', 'https://two.test']);
});
