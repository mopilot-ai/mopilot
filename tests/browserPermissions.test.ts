import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { anchorOf } = require('../electron/capabilities/contract/policy.cjs');
const { chatAnchorOf } = require('../electron/capabilities/anchor.cjs');
const { panelBrowserTools } = require('../electron/capabilities/browser/tools.cjs');
const { chromeTools } = require('../electron/capabilities/browser/extension.cjs');
const ctx = { chatId: 'chat', segmentId: 'segment' };
const site = 'http://127.0.0.1:56436';

test('browser permission entrypoint preserves shared policy function and constant identities', () => {
  const permissions = require('../electron/capabilities/browser/origins.cjs');
  const policy = require('../electron/capabilities/browser/originPolicy.cjs');
  for (const name of ['originOf', 'isBlank', 'isLoopback', 'covers', 'decide', 'riskView', 'readOnlyNote', 'LEVELS', 'BROWSERS'])
    assert.equal(permissions[name], policy[name], name);
});

function temporary(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-permissions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('browser permission anchor reads the live session before app defaults, including reported ACP modes', () => {
  let session: any = { permission: null, acp: null };
  let harness = 'codex';
  let fallback = 'full-access';
  const deps = {
    sessions: { get: (id: string) => (assert.equal(id, ctx.chatId), session) },
    controller: { ref: (id: string) => (assert.equal(id, ctx.chatId), { kind: harness }) },
    prefs: () => ({ permission: fallback }),
  };
  assert.equal(chatAnchorOf(ctx.chatId, deps), 'full');
  session.permission = 'read-only';
  assert.equal(chatAnchorOf(ctx.chatId, deps), 'readOnly');
  harness = 'claude';
  session.permission = 'bypassPermissions';
  fallback = 'default';
  assert.equal(chatAnchorOf(ctx.chatId, deps), 'full');
  harness = 'acp:test';
  session = { permission: null, acp: { modes: { currentModeId: 'safe' }, anchors: { safe: 'readOnly' } } };
  assert.equal(chatAnchorOf(ctx.chatId, deps), 'readOnly');
});

test('legacy allowed answers without an access level use the requested level', async () => {
  const grants = new OriginGrants({ ask: async () => ({ decision: 'allow', scope: 'chat' }) });
  await grants.require(site, 'write', ctx);
  await grants.require(site, 'read', ctx);
  await grants.require(site, 'write', ctx);
});

test('a saved file without an origins object starts with no grants', (t) => {
  const file = path.join(temporary(t), 'sites.json');
  fs.writeFileSync(file, '{}');
  assert.deepEqual(new OriginGrants({ file, ask: async () => null }).list(), []);
});

test('Full access allows reads and writes without prompts or permanent grants across harnesses', async () => {
  for (const session of [
    { harness: 'codex', permission: 'full-access' },
    { harness: 'claude', permission: 'bypassPermissions' },
    { harness: 'acp:test', acp: { modes: { currentModeId: 'all' }, anchors: { all: 'full' } } },
  ]) {
    let asks = 0;
    const grants = new OriginGrants({ anchor: () => anchorOf(session), ask: async () => (++asks, { decision: 'deny' }) });
    await grants.require(`${site}/`, 'read', ctx);
    await grants.require(`${site}/form`, 'write', ctx);
    await grants.require('https://another.test/', 'write', ctx);
    assert.equal(asks, 0);
    assert.deepEqual(grants.list(), []);
    await assert.rejects(grants.require('file:///etc/hosts', 'read', ctx), { code: 'blocked' });
    await assert.rejects(grants.require('ftp://files.test/', 'read', ctx), { code: 'bad_url' });
  }
});

test('Full access follows the current chat and switching back restores site prompts', async () => {
  let full = true;
  const asked: any[] = [];
  const grants = new OriginGrants({
    anchor: ({ chatId }: any) => (chatId === ctx.chatId && full ? 'full' : 'ask'),
    ask: async (q: any) => (asked.push(q), { decision: 'allow', scope: 'once', level: 'write' }),
  });
  await grants.require(site, 'write', ctx);
  await grants.require(site, 'write', { ...ctx, chatId: 'other' });
  assert.equal(asked.length, 1);
  full = false;
  await grants.require(site, 'write', ctx);
  assert.equal(asked.length, 2);
  assert.deepEqual(grants.list(), []);
});

test('read-only chat mode refuses writes even with a saved write grant', async () => {
  const grants = new OriginGrants({ anchor: () => 'readOnly', ask: async () => assert.fail('must not ask') });
  grants.set(site, 'write');
  await grants.require(site, 'read', ctx);
  await assert.rejects(grants.require(site, 'write', ctx), { code: 'read_only' });
});

test('Always allow survives concurrent calls, another chat and a restart; ports and levels stay distinct', async (t) => {
  const file = path.join(temporary(t), 'sites.json');
  let asks = 0;
  const grants = new OriginGrants({ file, ask: async () => (++asks, { decision: 'allow', scope: 'always', level: 'read' }) });
  await Promise.all([grants.require(`${site}/one`, 'read', ctx), grants.require(`${site}/two`, 'read', ctx)]);
  await grants.require(`${site}/three`, 'read', { ...ctx, chatId: 'other' });
  assert.equal(asks, 1);
  const restarted = new OriginGrants({ file, ask: async () => (++asks, { decision: 'allow', scope: 'once', level: 'read' }) });
  await restarted.require(site, 'read', ctx);
  // a write on the site allowed for reading asks (#1319 G22); this card's answer is read again, so it is refused
  await assert.rejects(restarted.require(site, 'write', ctx), { code: 'read_only' });
  assert.equal(asks, 2);
  await restarted.require('http://127.0.0.1:56437', 'read', ctx);
  assert.equal(asks, 3);
  assert.deepEqual(restarted.list(), [{ origin: site, level: 'read' }]);
});

test('a call arriving as the in-flight approval clears sees the saved Always allow grant', async (t) => {
  const file = path.join(temporary(t), 'sites.json');
  let asks = 0;
  const grants = new OriginGrants({ file, ask: async () => (++asks, { decision: 'allow', scope: 'always', level: 'write' }) });
  let late: Promise<void> | undefined;
  const originalDelete = grants.asking.delete.bind(grants.asking);
  // Inject a real browser request at the cleanup boundary, before the first caller resumes.
  t.mock.method(grants.asking, 'delete', (key: string) => {
    const removed = originalDelete(key);
    if (!late) late = grants.require(`${site}/late`, 'write', ctx);
    return removed;
  });
  await grants.require(site, 'read', ctx);
  await late;
  assert.equal(asks, 1, 'the late request must reuse the saved grant');
  assert.equal(new OriginGrants({ file, ask: async () => null }).get(site), 'write');
});

test('concurrent read and write requests share one card without escalating a read-only answer', async () => {
  let asks = 0;
  const grants = new OriginGrants({ ask: async () => (++asks, { decision: 'allow', scope: 'chat', level: 'read' }) });
  const results = await Promise.allSettled([grants.require(site, 'read', ctx), grants.require(site, 'write', ctx)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal((results[1] as PromiseRejectedResult).reason.code, 'read_only');
  await grants.require(site, 'read', ctx);
  // the shared card asked for reading: a later write asks for writing (#1319 G22), here answered read again
  await assert.rejects(grants.require(site, 'write', ctx), { code: 'read_only' });
  assert.equal(asks, 2);
});

test('failed Always allow persistence reports an error, rolls back and permits a successful retry', async (t) => {
  const dir = temporary(t);
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'a file, not a directory');
  const file = path.join(blocked, 'sites.json');
  let asks = 0;
  const grants = new OriginGrants({ file, ask: async () => (++asks, { decision: 'allow', scope: 'always', level: 'write' }) });
  await assert.rejects(grants.require(site, 'write', ctx), { code: 'save_failed' });
  assert.deepEqual(grants.list(), []);
  assert.equal(grants.asking.size, 0);
  fs.unlinkSync(blocked);
  await grants.require(site, 'write', ctx);
  assert.equal(asks, 2);
  assert.equal(new OriginGrants({ file, ask: async () => null }).get(site), 'write');
});

test('failed Settings edits and removals retain the previously saved permission', async (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'sites.json');
  const grants = new OriginGrants({ file, ask: async () => null });
  grants.set(site, 'write');
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'blocked');
  grants.file = path.join(blocked, 'sites.json');
  for (const level of ['read', null]) {
    assert.throws(() => grants.set(site, level), { code: 'save_failed' });
    assert.equal(grants.get(site), 'write');
    assert.equal(new OriginGrants({ file, ask: async () => null }).get(site), 'write');
  }
});

test('a Deny denies access for the chat and is never saved as a grant', async () => {
  let asks = 0;
  const grants = new OriginGrants({ ask: async () => (++asks, { decision: 'deny' }) });
  await assert.rejects(grants.require(site, 'read', ctx), { code: 'denied' });
  await assert.rejects(grants.require(site, 'read', ctx), { code: 'denied' });
  assert.equal(asks, 1);
  assert.deepEqual(grants.list(), []);
});

test('both browser channels use Full access while retaining the remote off switch', async () => {
  const grants = new OriginGrants({ anchor: () => 'full', ask: async () => assert.fail('must not ask') });
  let enabled = true;
  const calls: string[] = [];
  const wc = { getURL: () => site, isDestroyed: () => false };
  const panel = {
    tab: async () => ({ backend: wc, refs: new Map() }),
    url: async () => site,
    navigate: async (_chat: string, url: string) => (calls.push('panel navigate'), { url, title: '' }),
    click: async () => calls.push('panel click'),
    intent: async () => null,
  };
  const inst = {
    url: site,
    call: async (name: string) => (calls.push(name), { content: [{ type: 'text', text: `### Page\n- Page URL: ${site}` }] }),
  };
  const defs = [
    ...panelBrowserTools({ panel, grants, enabled: () => enabled }),
    ...chromeTools({ channel: { instance: async () => inst }, grants, enabled: () => enabled, schemas: [{ name: 'browser_click' }] }),
  ];
  await defs.find((d: any) => d.name === 'sage_browser_navigate').handler({ url: site }, ctx);
  for (const d of defs.filter((d: any) => d.name.includes('click'))) await d.handler({ ref: 'e1' }, ctx);
  // Your Chrome reads what the click targets (its sensitive-action check), then clicks
  assert.deepEqual(calls, ['panel navigate', 'panel click', 'browser_snapshot', 'browser_evaluate', 'browser_snapshot', 'browser_click']);
  enabled = false;
  for (const d of defs.filter((d: any) => d.name.includes('click')))
    await assert.rejects(d.handler({ ref: 'e1' }, ctx), { code: 'disabled' });
  assert.equal(calls.length, 6);
});

test('isLoopback: localhost, *.localhost, 127.x and [::1] are local servers; anything else or a bad origin is not', () => {
  const { isLoopback } = require('../electron/capabilities/browser/origins.cjs');
  for (const o of ['http://localhost:3000', 'https://app.localhost', 'http://127.0.0.1:8080', 'http://127.1.2.3', 'http://[::1]:5173'])
    assert.equal(isLoopback(o), true, o);
  for (const o of ['https://example.com', 'http://localhost.example.com', 'http://128.0.0.1', 'not a url', ''])
    assert.equal(isLoopback(o), false, o);
});

test('peek: what a call would get without asking, for blank, non-web, read-only chat, Full access, granted, read-to-write (asks) and denied sites', async () => {
  let anchor = 'ask';
  const g = new OriginGrants({ ask: async () => ({ decision: 'deny' }), anchor: () => anchor });
  assert.equal(g.peek('', 'read', ctx), 'blank');
  assert.equal(g.peek('about:blank', 'write', ctx), 'blank');
  assert.equal(g.peek('file:///etc/passwd', 'read', ctx), 'blocked');
  assert.equal(g.peek('ftp://files.test/x', 'read', ctx), 'other');
  assert.equal(g.peek('https://a.test/x', 'read', ctx), 'ask');
  anchor = 'readOnly';
  assert.equal(g.peek('https://a.test/x', 'write', ctx), 'read_only');
  assert.equal(g.peek('https://a.test/x', 'read', ctx), 'ask');
  anchor = 'full';
  assert.equal(g.peek('https://a.test/x', 'write', ctx), 'ok');
  anchor = 'ask';
  g.grants.set('https://a.test', 'read');
  assert.equal(g.peek('https://a.test/x', 'read', ctx), 'ok');
  // a write on a site allowed for reading asks again, never a dead end (#1319 G22)
  assert.equal(g.peek('https://a.test/x', 'write', ctx), 'reask');
  // a chat grant covers what the site grant does not
  g.chatGrants.set(ctx.chatId, new Map([['https://a.test', 'write']]));
  assert.equal(g.peek('https://a.test/x', 'write', ctx), 'ok');
  assert.equal(g.peek('https://a.test/x', 'write', { ...ctx, chatId: 'other' }), 'reask');
  // denied in this chat only
  await assert.rejects(g.require('https://b.test/', 'read', ctx), { code: 'denied' });
  assert.equal(g.peek('https://b.test/', 'read', ctx), 'denied');
  assert.equal(g.peek('https://b.test/', 'read', { ...ctx, chatId: 'other' }), 'ask');
  // the same site with a trailing dot is the same origin: denied, and granted, the same way
  assert.equal(g.peek('https://b.test./x', 'read', ctx), 'denied');
  assert.equal(g.peek('https://a.test.:443/x', 'read', ctx), 'ok');
  const { originOf } = require('../electron/capabilities/browser/origins.cjs');
  assert.deepEqual(['https://a.test./', 'http://a.test.:8080/p', 'https://a.test/', 'https://[::1]:3000/'].map(originOf), [
    'https://a.test',
    'http://a.test:8080',
    'https://a.test',
    'https://[::1]:3000',
  ]);
});

test('require: the card offers read and write for a navigation, and a local server is allowed for good to read only', async () => {
  const asked: any[] = [];
  let answer: any = { decision: 'allow', scope: 'always', level: 'write' };
  const g = new OriginGrants({ ask: async ({ signal: _signal, ...req }: any) => (asked.push(req), answer) });
  // a public site: the offered level is shown, "always" saves the grant
  await g.require('https://a.test/x', 'read', ctx, { offer: 'write', localAlways: false });
  assert.deepEqual(asked.pop(), { chatId: ctx.chatId, segmentId: ctx.segmentId, browser: 'iab', origin: 'https://a.test', need: 'write' });
  assert.equal(g.get('https://a.test'), 'write');
  // an unknown offer falls back to what the call needs
  await g.require('https://c.test/', 'read', ctx, { offer: 'admin' });
  assert.equal(asked.pop().need, 'read');
  // a loopback origin: "Always allow" is for reading only, and an "always" answer to write counts for this chat only
  await g.require(`${site}/app`, 'read', ctx, { offer: 'write', localAlways: false });
  assert.deepEqual(asked.pop(), {
    chatId: ctx.chatId,
    segmentId: ctx.segmentId,
    browser: 'iab',
    origin: site,
    need: 'write',
    allowAlways: 'read',
  });
  assert.equal(g.get(site), null, 'writing is not saved for good');
  assert.equal(g.chatGrants.get(ctx.chatId).get(site), 'write');
  assert.equal(g.peek(`${site}/other`, 'write', ctx), 'ok');
  assert.equal(g.peek(`${site}/other`, 'read', { ...ctx, chatId: 'next' }), 'ask', 'another chat asks again');
  // the first chat grant of a chat creates its map
  answer = { decision: 'allow', scope: 'always', level: 'read' };
  await g.require('http://localhost:4000/', 'read', { ...ctx, chatId: 'fresh' }, { localAlways: false });
  // an "always" answer to read is saved for good: every chat reads there, and writing there still asks
  assert.equal(g.get('http://localhost:4000'), 'read');
  assert.equal(g.peek('http://localhost:4000/x', 'read', { ...ctx, chatId: 'another' }), 'ok');
  assert.equal(
    g.peek('http://localhost:4000/x', 'write', { ...ctx, chatId: 'another' }),
    'reask',
    'a local server asks about a write, not refuses it',
  );
  // the write card is put up; a yes for the chat lets it through while reading stays allowed for good
  answer = { decision: 'allow', scope: 'chat', level: 'write' };
  await g.require('http://localhost:4000/x', 'write', { ...ctx, chatId: 'another' }, { offer: 'write', localAlways: false });
  assert.equal(g.peek('http://localhost:4000/x', 'write', { ...ctx, chatId: 'another' }), 'ok');
  assert.equal(g.get('http://localhost:4000'), 'read');
  g.set('https://readonly.test', 'read');
  assert.equal(
    g.peek('https://readonly.test/x', 'write', { ...ctx, chatId: 'another' }),
    'reask',
    'a public site allowed for reading asks about a write too (#1319 G22)',
  );
  // the default (sage_browser_* and Your Chrome): a loopback "always" is saved as before
  answer = { decision: 'allow', scope: 'always', level: 'read' };
  await g.require('http://localhost:5000/', 'read', ctx);
  assert.equal(asked.pop().allowAlways, undefined);
  assert.equal(g.get('http://localhost:5000'), 'read');
});

/* ---------------- a card answered with less than it asked for (IAB-09) ---------------- */

test('a write call answered Read only: the call and later writes in the turn are refused with one clear error, without a second card; reads run', async () => {
  const { readOnlyNote } = require('../electron/capabilities/browser/origins.cjs');
  const asked: any[] = [];
  let answer: any = { decision: 'allow', scope: 'chat', level: 'read' };
  const g = new OriginGrants({ ask: async ({ signal: _signal, ...q }: any) => (asked.push(q), answer) });
  const note = readOnlyNote('https://a.test');
  assert.match(
    note,
    /^The user gave https:\/\/a\.test read-only access: you can read its pages but not click, type or change anything there\. Don't retry or work around this; ask the user in chat whether to allow read and write\.$/,
  );
  // the panel tools ask for what the call needs: write
  await assert.rejects(g.require('https://a.test/form', 'write', ctx), (e: any) => e.code === 'read_only' && e.message === note);
  assert.deepEqual(
    asked.map((q) => q.need),
    ['write'],
  );
  await assert.rejects(g.require('https://a.test/form', 'write', ctx), (e: any) => e.code === 'read_only' && e.message === note);
  assert.equal(g.peek('https://a.test/x', 'write', ctx), 'read_only');
  await g.require('https://a.test/x', 'read', ctx);
  assert.equal(g.peek('https://a.test/x', 'read', ctx), 'ok');
  assert.equal(asked.length, 1, 'no second card this turn');
  // another chat is not affected
  assert.equal(g.peek('https://a.test/x', 'write', { ...ctx, chatId: 'other' }), 'ask');
  // next turn: the chat grant is read, the next write asks again; read and write (in this chat) lets it through for good
  g.turnEnded(ctx.chatId);
  assert.equal(g.peek('https://a.test/x', 'write', ctx), 'reask');
  answer = { decision: 'allow', scope: 'chat', level: 'write' };
  await g.require('https://a.test/form', 'write', ctx);
  assert.deepEqual(asked.at(-1), { chatId: 'chat', segmentId: 'segment', browser: 'iab', origin: 'https://a.test', need: 'write' });
  await g.require('https://a.test/form', 'write', ctx);
  assert.equal(asked.length, 2);
  assert.equal(g.peek('https://a.test/x', 'write', ctx), 'ok');
  assert.equal(g.lowered.get(ctx.chatId).size, 0);
});

test('a navigation answered Read only (the card offered read and write): reading goes on, writes are refused this turn, asked again next turn', async () => {
  const asked: any[] = [];
  const answers: any[] = [{ decision: 'allow', scope: 'once', level: 'read' }];
  const g = new OriginGrants({ ask: async (q: any) => (asked.push(q), answers.shift() ?? { decision: 'deny' }) });
  const nav = { offer: 'write', localAlways: false };
  await g.require('https://b.test/', 'read', ctx, nav);
  assert.deepEqual(
    asked.map((q) => q.need),
    ['write'],
  );
  assert.equal(g.peek('https://b.test/', 'write', ctx), 'read_only');
  await assert.rejects(g.require('https://b.test/', 'write', ctx), { code: 'read_only' });
  assert.equal(asked.length, 1);
  // a turn ends: asked again; Read only again starts a new refusal for that turn
  g.turnEnded(ctx.chatId);
  answers.push({ decision: 'allow', scope: 'once', level: 'read' });
  await assert.rejects(g.require('https://b.test/', 'write', ctx), { code: 'read_only' });
  assert.equal(asked.length, 2);
  assert.equal(g.peek('https://b.test/', 'write', ctx), 'read_only');
  // asked again and allowed read and write once: the refusal ends; once stores nothing
  g.turnEnded(ctx.chatId);
  answers.push({ decision: 'allow', scope: 'once', level: 'write' });
  await g.require('https://b.test/', 'write', ctx);
  assert.equal(g.peek('https://b.test/', 'write', ctx), 'ask');
  // a later Read only, then a denial when asked again: denied wins
  answers.push({ decision: 'allow', scope: 'once', level: 'read' });
  await g.require('https://b.test/', 'read', ctx, nav);
  g.turnEnded(ctx.chatId);
  await assert.rejects(g.require('https://b.test/', 'write', ctx), { code: 'denied' });
  assert.equal(g.peek('https://b.test/', 'write', ctx), 'denied');
  await assert.rejects(g.require('https://b.test/', 'write', ctx), { code: 'denied' });
  assert.equal(asked.length, 5);
});

test('Read only on a high-risk site keeps its rules: the card shows the risk, offers Always allow, and writes are refused without a loop', async () => {
  const asked: any[] = [];
  const g = new OriginGrants({ ask: async (q: any) => (asked.push(q), { decision: 'allow', scope: 'always', level: 'read' }) });
  await assert.rejects(g.require('https://www.chase.com/', 'write', ctx), { code: 'read_only' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].allowAlways, undefined);
  assert.equal(asked[0].risk.level, 'high');
  // "always" on a high-risk site saves it for good (#5464), at the level picked
  assert.equal(g.get('https://www.chase.com'), 'read');
  await assert.rejects(g.require('https://www.chase.com/', 'write', ctx), { code: 'read_only' });
  await g.require('https://www.chase.com/', 'read', ctx);
  assert.equal(asked.length, 1);
});

test('the read-only refusal ends with a Settings change for the site or the chat being forgotten; a turn end with nothing lowered does nothing', async () => {
  const g = new OriginGrants({ ask: async () => ({ decision: 'allow', scope: 'once', level: 'read' }) });
  g.turnEnded(ctx.chatId);
  assert.equal(g.lowered.size, 0);
  await assert.rejects(g.require('https://c.test/', 'write', ctx), { code: 'read_only' });
  assert.equal(g.peek('https://c.test/', 'write', ctx), 'read_only');
  g.set('https://c.test', 'write');
  assert.equal(g.peek('https://c.test/', 'write', ctx), 'ok');
  g.set('https://c.test', null);
  await assert.rejects(g.require('https://c.test/', 'write', ctx), { code: 'read_only' });
  g.forget(ctx.chatId);
  assert.equal(g.peek('https://c.test/', 'write', ctx), 'ask');
});

test('a failed permission rename removes temporary grants and permits a clean retry', (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'sites.json');
  fs.mkdirSync(file);
  const grants = new OriginGrants({ file, ask: async () => null });
  assert.throws(() => grants.set(site, 'write'), { code: 'save_failed' });
  assert.deepEqual(grants.list(), []);
  assert.deepEqual(fs.readdirSync(dir), ['sites.json']);
  fs.rmdirSync(file);
  assert.equal(grants.set(site, 'read'), true);
  assert.equal(new OriginGrants({ file, ask: async () => null }).get(site), 'read');
});

test('saved permissions remain private when an old temporary file has broader access', (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'sites.json');
  const stale = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(stale, 'old grants');
  fs.chmodSync(stale, 0o644);
  const grants = new OriginGrants({ file, ask: async () => null });
  grants.set(site, 'write');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(stale, 'utf8'), 'old grants');
});

test('a shared legacy read approval never escalates a concurrent write request', async () => {
  for (const scope of ['once', 'chat', 'always']) {
    const asked: string[] = [];
    const grants = new OriginGrants({
      ask: async (question: any) => {
        asked.push(question.need);
        return { decision: 'allow', scope };
      },
    });
    const results = await Promise.allSettled([grants.require(site, 'read', ctx), grants.require(site, 'write', ctx)]);
    assert.deepEqual(asked, ['read']);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal((results[1] as PromiseRejectedResult).reason.code, 'read_only');
  }
});

test('a shared legacy write approval continues to cover a concurrent read request', async () => {
  const asked: string[] = [];
  const grants = new OriginGrants({
    ask: async (question: any) => {
      asked.push(question.need);
      return { decision: 'allow', scope: 'once' };
    },
  });
  await Promise.all([grants.require(site, 'write', ctx), grants.require(site, 'read', ctx)]);
  assert.deepEqual(asked, ['write']);
});

test("a consent the user gave on Codex's Browser plugin card keeps its scope as the chat's site grant", async () => {
  const asked: any[] = [];
  const confirms: any[] = [];
  const g = new OriginGrants({
    ask: async (q: any) => (asked.push(q), { decision: 'deny' }),
    confirmAction: async (q: any) => (confirms.push(q), true),
  });
  // what can't be recorded: no chat, not an origin, an unknown scope, a blocked site
  assert.equal(g.consented('', 'https://a.test', 'chat'), false);
  assert.equal(g.consented('chat', 'https://a.test/path', 'chat'), false);
  assert.equal(g.consented('chat', 'https://a.test', 'forever'), false);
  const classify = g.risk.classify;
  g.risk.classify = () => ({ level: 'blocked' });
  assert.equal(g.consented('chat', 'https://blocked.test', 'always'), false);
  g.risk.classify = classify;
  // always on an ordinary site: saved for good, and a denial or a downgrade in this chat is lifted
  g.denied.set('chat', new Set(['https://a.test']));
  g.lowered.set('chat', new Map([['https://a.test', 'turn']]));
  assert.equal(g.consented('chat', 'https://a.test', 'always'), true);
  assert.equal(g.get('https://a.test'), 'write');
  assert.equal(g.peek('https://a.test/', 'write', ctx), 'ok');
  assert.equal(g.consented('chat', 'https://a.test', 'always'), true, 'already saved: nothing more to save');
  // always on a high-risk site or a local server: for this chat only
  assert.equal(g.consented('chat', 'https://www.chase.com', 'always'), true);
  assert.equal(g.get('https://www.chase.com'), null);
  await g.require('https://www.chase.com/', 'write', ctx);
  assert.equal(g.consented('chat', site, 'always'), true);
  assert.equal(g.get(site), null);
  assert.equal(g.peek(`${site}/`, 'write', ctx), 'ok');
  assert.equal(g.peek(`${site}/`, 'write', { chatId: 'other', segmentId: 's' }), 'ask');
  // chat: for this chat only
  assert.equal(g.consented('chat', 'https://b.test', 'chat'), true);
  assert.equal(g.peek('https://b.test/', 'write', ctx), 'ok');
  assert.equal(asked.length, 0);
  // the high-risk site's actions still ask each time
  await g.act('https://www.chase.com/', ctx, { tool: 'click' });
  assert.equal(confirms.length, 1);
});

test('a once consent covers the next check in its turn, never a URL with credentials, and lapses at the turn end or when the chat is forgotten', async () => {
  const asked: any[] = [];
  const g = new OriginGrants({ ask: async (q: any) => (asked.push(q), { decision: 'deny' }) });
  assert.equal(g.consented('chat', 'https://www.chase.com', 'once'), true);
  assert.equal(g.consented('chat', 'https://c.test', 'once'), true);
  await g.require('https://www.chase.com/', 'write', ctx);
  assert.equal(asked.length, 0);
  await assert.rejects(g.require('https://www.chase.com/', 'write', ctx), { code: 'denied' });
  assert.equal(asked.length, 1, 'used once: the next check asks');
  await assert.rejects(g.require('https://u:p@c.test/', 'write', ctx), { code: 'denied' });
  assert.equal(asked.length, 2, 'credentials in the URL always ask');
  g.consented('chat', 'https://d.test', 'once');
  g.turnEnded('chat');
  assert.equal(g.passes.has('chat'), false);
  g.consented('chat', 'https://d.test', 'once');
  g.forget('chat');
  assert.equal(g.passes.has('chat'), false);
});

test('a site card that cannot be shown is not a refusal: the check fails as unavailable, nothing is remembered, and the next check asks again', async () => {
  let asks = 0;
  let fail = true;
  const grants = new OriginGrants({
    ask: async () => {
      asks++;
      if (fail) throw new Error('no window to show the card');
      return { decision: 'allow', level: 'read', scope: 'chat' };
    },
  });
  // two checks waiting on one card share its failure
  const both = await Promise.allSettled([grants.require(site, 'read', ctx), grants.require(site, 'read', ctx)]);
  assert.equal(asks, 1);
  for (const r of both) {
    assert.equal(r.status, 'rejected');
    assert.equal((r as any).reason.code, 'unavailable');
    assert.match(
      (r as any).reason.message,
      /Couldn't ask the user about http:\/\/127\.0\.0\.1:56436: no window to show the card\. Try again\./,
    );
  }
  assert.equal(grants.denied.has('chat'), false);
  // a failure that is not an Error is named too
  grants.ask = () => Promise.reject('broker gone');
  await assert.rejects(grants.require(site, 'read', ctx), { code: 'unavailable', message: /broker gone/ });
  grants.ask = async () => (asks++, fail ? null : { decision: 'allow', level: 'read', scope: 'chat' });
  fail = false;
  await grants.require(site, 'read', ctx);
  assert.equal(asks, 2, 'asked again: the failed card was not taken as an answer');
});

test("an action's confirmation that cannot be shown fails as unavailable; a no is still a denial", async () => {
  let answer: any = new Error('broker gone');
  const grants = new OriginGrants({
    ask: async () => assert.fail('must not ask'),
    confirmAction: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const sensitive = { verb: 'delete' };
  await assert.rejects(grants.act('https://a.test/', ctx, { sensitive }), {
    code: 'unavailable',
    message: "Couldn't ask the user about https://a.test: broker gone. Try again.",
  });
  answer = false;
  await assert.rejects(grants.act('https://a.test/', ctx, { sensitive }), { code: 'denied' });
  answer = true;
  await grants.act('https://a.test/', ctx, { sensitive });
});
