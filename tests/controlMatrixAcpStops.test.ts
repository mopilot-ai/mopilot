// CM-K28 to CM-K30: an ACP session that is not the chat's current one, one that works with no prompt, and a browser card nobody is there to answer (#1319 G11, G17, G18).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { acpSession, IAB, world } from './support/control-matrix-kit.ts';
import { setup } from './support/controller/fixture.ts';

export const GUARDS = [
  'electron/app/',
  'electron/capabilities/',
  'electron/harness/',
  'electron/platform/',
  'electron/session/',
  'shared/',
];

const require = createRequire(import.meta.url);
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { siteTables } = require('../electron/app/browserSiteTables.cjs');
const { turnLedger } = require('../electron/capabilities/turnEnd.cjs');
const text = (r: any) => r?.content?.[0]?.text ?? '';

test("CM-K28: Stop on an ACP session that isn't the chat's current one stops its own calls only; the current segment's go on (#1319 G17)", async () => {
  const w = world();
  const old = await acpSession(w, { chatId: 'c1', segmentId: 'old-seg' });
  const now = await acpSession(w, { chatId: 'c1', segmentId: 'now-seg' });
  w.hold(IAB);
  const stale = old.call(IAB, {});
  const current = now.call(IAB, {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.r.abortChat('c1', 'stopped', 'old-seg'), 1);
  const r = await stale;
  assert.equal(r.isError, true);
  w.release(IAB);
  assert.equal(text(await current), `ran ${IAB}`);
  // a segment with nothing running, or a chat with nothing running, stops nothing
  assert.equal(w.r.abortSegment('c1', 'old-seg'), 0);
  assert.equal(w.r.abortSegment('nobody', 'x'), 0);
  // the chat's last running call stopped by its segment: nothing of the chat is left running
  w.hold(IAB);
  const last = old.call(IAB, {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.r.abortSegment('c1', 'old-seg'), 1);
  assert.equal((await last).isError, true);
  assert.equal(w.r.running.has('c1'), false);
  w.release(IAB);

  // the controller: Stop reaching a session that is no longer current lets go of that segment only
  const { c } = setup();
  const seen: any[] = [];
  c.onInterrupt = (...a: any[]) => void seen.push(a);
  c.isCurrentSource = () => false;
  c.acpCancel('acp:test:old');
  assert.deepEqual(seen, [['acp:test:old', 'acp:test:old']]);
});

test('CM-K29: an ACP harness that works with no prompt is cancelled and its MoPilot calls stop too (#1319 G18)', () => {
  const { c } = setup();
  const seen: any[] = [];
  c.onInterrupt = (...a: any[]) => void seen.push(a);
  c.acpSend('acp:test:one', 'acp:test:one', {}, { uuid: 'u1' });
  c.onAcpEvent({ key: 'acp:test:one', kind: 'unattended', reason: 'tool call' });
  // an event for a chat that isn't known changes nothing
  c.onAcpEvent({ key: 'acp:nobody', kind: 'unattended', reason: 'tool call' });
  assert.deepEqual(seen, [[c.chatOf('acp:test:one'), 'acp:test:one']]);
  // the turn ledger's hook: a segment stops its own calls and keeps the chat's thread state; the chat stops all of them
  const calls: any[] = [];
  const ledger = turnLedger({
    steps: [],
    abortChat: (...a: any[]) => void calls.push(a),
    chatOf: (id: string) => id,
    running: () => false,
    tracked: () => true,
  });
  ledger.hooks.onInterrupt('c1', 'seg-1');
  ledger.hooks.onInterrupt('c1');
  assert.deepEqual(calls, [
    ['c1', 'stopped', 'seg-1'],
    ['c1', 'stopped'],
  ]);
});

test('CM-K30: an ACP browser call outside a prompt never puts up a site or action card; it ends as unattended (#1319 G11)', async () => {
  let away: string | null = 'a tool call outside a prompt';
  let asks = 0;
  let confirms = 0;
  const g = new OriginGrants({
    attended: () => away,
    ask: async () => (++asks, { decision: 'allow', scope: 'once', level: 'write' }),
    confirmAction: async () => (++confirms, true),
  });
  const ctx = { chatId: 'c1', segmentId: 's1' };
  await assert.rejects(
    g.require('https://a.test/', 'read', ctx),
    (e: any) => e.code === 'unattended' && /nobody is here to answer it \(a tool call outside a prompt\)/.test(e.message),
  );
  await assert.rejects(g.act('https://a.test/', ctx, { sensitive: { verb: 'delete' } }), { code: 'unattended' });
  assert.deepEqual([asks, confirms], [0, 0]);
  // what needs no card still runs; with the prompt running, the cards go up as before
  g.set('https://ok.test', 'write');
  await g.require('https://ok.test/', 'write', ctx);
  away = null;
  await g.require('https://a.test/', 'read', ctx);
  await g.act('https://a.test/', ctx, { sensitive: { verb: 'delete' } });
  assert.deepEqual([asks, confirms], [1, 1]);

  // main's tables: an ACP chat with no running turn is away; Claude Code, Codex and a running ACP turn are attended
  const sessions = new Map<string, any>([
    ['acp-idle', { activeTurn: null }],
    ['acp-busy', { activeTurn: { id: 't' } }],
    ['claude-idle', { activeTurn: null }],
  ]);
  const kinds: Record<string, string> = { 'acp-idle': 'acp:opencode', 'acp-busy': 'acp:opencode', 'claude-idle': 'claude' };
  const live: any = {
    sessions,
    controller: {
      ref: (id: string) => ({ kind: kinds[id], id: null }),
      // the ACP turn adapter says its harness can call tools with no prompt running
      adapterOf: (id: string) => (kinds[id].startsWith('acp') ? { toolsOutsidePrompt: true } : {}),
    },
    computerUse: { broker: { ask: async () => ({ decision: 'allow', scope: 'once', level: 'write' }) } },
  };
  const { browserGrants, chromeGrants } = siteTables({ live, dir: '/tmp/none', prefs: {}, isFlagEnabled: () => false });
  for (const t of [browserGrants, chromeGrants]) {
    assert.equal(t.attended({ chatId: 'acp-idle', segmentId: 's' }), 'a tool call outside a prompt');
    assert.equal(t.attended({ chatId: 'acp-busy', segmentId: 's' }), null);
    assert.equal(t.attended({ chatId: 'claude-idle', segmentId: 's' }), null);
  }
  assert.deepEqual([browserGrants.browser, chromeGrants.browser], ['iab', 'chrome']);
});
