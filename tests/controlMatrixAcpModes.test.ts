// The control matrix (docs/control-plane/matrix.md), permission tiers on every harness: an ACP harness's modes reach
// MoPilot's computer and browser tools as the same tiers Claude Code's and Codex's modes do, read from the
// shipped quirks files (never a map written for the test), and computer use and the browser read one rule for a chat,
// also before its session reports a mode. Case ids (CM-J..) start every title. The quirks, the anchor rule, OriginGrants
// and the computer-use tools are real; the helper, the sessions and the harnesses are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/capabilities/', 'electron/harness/', 'shared/'];

const require = createRequire(import.meta.url);
const Q = require('../electron/harness/quirks/index.cjs');
const { chatAnchorOf } = require('../electron/capabilities/anchor.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { ComputerUse } = require('../electron/capabilities/tools/computer.cjs');

const CHAT = 'chat-1';
const SITE = 'https://shop.test/';
const DELETE = { kind: 'delete', verb: 'delete something', detail: 'Delete' };

/** The session state an ACP chat reports: its mode through session modes (Gemini) or a `mode` config option (Kimi). */
function acpState(id: string, mode: string, via: 'modes' | 'config') {
  const anchors = Q.describe(id).anchors;
  if (via === 'modes')
    return { permission: null, acp: { anchors, modes: { currentModeId: mode, availableModes: [{ id: mode, name: mode }] } } };
  const option = { id: 'mode', type: 'select', category: 'mode', currentValue: mode, options: [{ value: mode, name: mode }] };
  return { permission: null, acp: { anchors, configOptions: [option] } };
}

/** chatAnchorOf's deps for one chat on `kind` whose session is `state`, with the app default `fallback`. */
const depsOf = (kind: string, state: any, fallback: string | null = 'default') => ({
  sessions: { get: () => state },
  controller: { ref: () => ({ kind }) },
  prefs: () => ({ permission: fallback }),
});

/** The computer-use tools over a fake helper, reading the chat's anchor the way main wires them (computerUse.cjs). */
function computerUse(deps: any) {
  const calls: string[] = [];
  const rec =
    (name: string, v: any = {}) =>
    async () => (calls.push(name), v);
  const helper: any = {
    running: true,
    start: rec('start'),
    targetInfo: rec('targetInfo', { bundleId: 'com.b', name: 'B', pid: 5 }),
    glowStart: rec('glowStart'),
    glowStop: rec('glowStop'),
    click: rec('click'),
    acquireControl: rec('acquire'),
    releaseControl: rec('release'),
    screenshot: rec('screenshot', { png: 'PNG', width: 10, height: 10 }),
    axSnapshot: rec('axSnapshot', {
      app: { name: 'B' },
      root: { id: 'e1', role: 'AXButton', title: 'OK', frame: { x: 0, y: 0, w: 1, h: 1 } },
    }),
    ocrElements: rec('ocr', []),
  };
  const cu = new ComputerUse({
    helper,
    grants: { forChat: () => [{ bundleId: 'com.b', level: 'full' }], deny: () => [], grant: () => {} },
    broker: { ask: async () => ({ decision: 'allow', scope: 'once' }) },
    session: (id: string) => deps.sessions.get(id),
    harness: (id: string) => deps.controller.ref(id).kind,
    anchor: (id: string) => chatAnchorOf(id, deps),
    settleMs: 0,
    waitMs: 0,
    pollMs: 1,
  });
  const by = Object.fromEntries(cu.tools().map((t: any) => [t.name, t.handler]));
  return { by, calls };
}

/** The in-app browser's site table with the chat's anchor; `confirmed` collects the "can't be undone" cards. */
function sites(anchor: () => string) {
  const confirmed: any[] = [];
  const g = new OriginGrants({
    browser: 'iab',
    anchor,
    ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }),
    confirmAction: async (req: any) => (confirmed.push(req), true),
  });
  g.set('https://shop.test', 'write');
  return { g, confirmed };
}

/** Gemini CLI's session modes and Kimi Code's mode values, as each harness declares them, with the tier each is. */
const MODES: [string, 'modes' | 'config', string, 'readOnly' | 'ask' | 'auto' | 'full'][] = [
  ['gemini', 'modes', 'default', 'ask'],
  ['gemini', 'modes', 'autoEdit', 'auto'],
  ['gemini', 'modes', 'yolo', 'full'],
  ['gemini', 'modes', 'plan', 'readOnly'],
  ['kimi', 'config', 'default', 'ask'],
  ['kimi', 'config', 'plan', 'readOnly'],
  ['kimi', 'config', 'auto', 'auto'],
  ['kimi', 'config', 'yolo', 'full'],
];

test('CM-J17: Gemini CLI’s and Kimi Code’s modes reach the computer and browser tools as their tiers, from the shipped quirks', async () => {
  for (const [id, via, mode, tier] of MODES) {
    const deps = depsOf(`acp:${id}`, acpState(id, mode, via));
    assert.equal(chatAnchorOf(CHAT, deps), tier, `${id} ${mode}`);
    // computer use: a plan mode only looks, every other mode clicks a granted app
    const { by, calls } = computerUse(deps);
    const click = by.computer_click({ x: 1, y: 1 }, { chatId: CHAT });
    if (tier === 'readOnly') await assert.rejects(click, /read-only mode/, `${id} ${mode}: computer use`);
    else {
      await click;
      assert.ok(calls.includes('click'), `${id} ${mode}: computer use`);
    }
    // the browser: an approve-everything mode runs an ordinary delete without the card, every other mode asks
    const { g, confirmed } = sites(() => chatAnchorOf(CHAT, deps));
    if (tier === 'readOnly') continue;
    // act answers whether it asked
    assert.equal(await g.act(SITE, { chatId: CHAT }, { tool: 'click', sensitive: DELETE }), tier !== 'full', `${id} ${mode}: browser`);
    assert.equal(confirmed.length, tier === 'full' ? 0 : 1, `${id} ${mode}: browser card`);
  }
});

test('CM-J18: guard: every shipped quirks file that declares plan anchors it read-only, and validation refuses one that doesn’t', () => {
  for (const id of Q.ids()) {
    const q = Q.quirks(id);
    assert.deepEqual(Q.validate(q), [], id);
    if (!q.plan) continue;
    assert.equal(q.anchors[q.plan.mode ?? q.plan.value], 'readOnly', `${id}: plan`);
  }
  const base = { label: 'X', bins: ['x'], args: [], privacyDefaults: [], admission: { handshakeTimeoutMs: 1 } };
  assert.deepEqual(Q.validate({ ...base, plan: { mode: 'plan' } }), ['plan anchor']);
  assert.deepEqual(Q.validate({ ...base, plan: { configOption: 'mode', value: 'plan' }, anchors: { plan: 'ask' } }), ['plan anchor']);
  assert.deepEqual(Q.validate({ ...base, plan: { configOption: 'mode', value: 'plan' }, anchors: { plan: 'readOnly' } }), []);
});

test('CM-J19: before a session reports its mode, computer use and the browser read the same tier, the app default it starts in', async () => {
  for (const kind of ['claude', 'codex', 'acp:gemini'])
    for (const [fallback, tier] of [
      ['read-only', 'readOnly'],
      ['full-access', 'full'],
      [null, 'ask'],
    ] as const) {
      const deps = depsOf(kind, kind.startsWith('acp') ? { acp: null } : undefined, fallback);
      assert.equal(chatAnchorOf(CHAT, deps), kind.startsWith('acp') ? 'ask' : tier, `${kind} ${fallback}`);
      if (kind.startsWith('acp')) continue;
      const { by, calls } = computerUse(deps);
      const click = by.computer_click({ x: 1, y: 1 }, { chatId: CHAT });
      if (tier === 'readOnly') await assert.rejects(click, /read-only mode/, `${kind} ${fallback}`);
      else {
        await click;
        assert.ok(calls.includes('click'), `${kind} ${fallback}`);
      }
      const { g, confirmed } = sites(() => chatAnchorOf(CHAT, deps));
      if (tier !== 'readOnly') {
        await g.act(SITE, { chatId: CHAT }, { tool: 'click', sensitive: DELETE });
        assert.equal(confirmed.length, tier === 'full' ? 0 : 1, `${kind} ${fallback}: browser card`);
      }
    }
});
