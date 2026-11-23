// The machine line's first-match order with the Remote Run states (shared/host/machineLine.mjs): cloud lifecycle, reconnecting, limit, paused, waiting; an ordinary machine reads as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineLine, usdText, RECONNECT_MS, TAIL_STATES as TAIL } from '../shared/host/machineLine.mjs';

const agents = [
  { id: 'claude', label: 'Claude Code', state: 'ready' as const },
  { id: 'codex', label: 'Codex', state: 'ready' as const },
];
const m = (o: object = {}) =>
  ({ status: 'online', note: '', agents, installable: [], lastSeen: null, localNetwork: 'unknown', waitingForLogin: null, ...o }) as any;
const now = 10_000_000;

test('an ordinary machine reads as before', () => {
  assert.deepEqual(machineLine(m(), now), { dot: 'ok', text: 'Online · Claude Code, Codex' });
  assert.deepEqual(machineLine(m({ status: 'offline', lastSeen: now - 5 * 60_000 }), now), {
    dot: 'off',
    text: 'Offline · seen 5 min ago',
  });
});

test('cloud lifecycle states, in order, before anything else', () => {
  const t = (cloud: string, extra: object = {}) => machineLine(m({ cloud, status: 'offline', ...extra }), now);
  assert.deepEqual(t('deleted'), { dot: 'off', text: 'Deleted at the provider' });
  assert.equal(t('creating').text, 'Creating…');
  assert.equal(t('setting-up').text, 'Setting up…');
  assert.deepEqual(t('connecting'), { dot: 'warn', text: 'Connecting…' });
  assert.deepEqual(t('waking'), { dot: 'warn', text: 'Waking…' });
  assert.deepEqual(t('asleep', { canWake: true }), { dot: 'off', text: 'Asleep · wakes on next message' });
  assert.deepEqual(t('asleep'), { dot: 'off', text: 'Asleep · wake it from your Mac' });
  assert.deepEqual(t('stopping'), { dot: 'warn', text: 'Stopping · idle' });
  assert.equal(t('deleted', { cloud: 'deleted', limit: { usd: 5 } }).text, 'Deleted at the provider');
});

test('reconnecting: a link that dropped under 90 s ago, after offline in the order', () => {
  assert.deepEqual(machineLine(m({ linkDroppedAt: now - 5_000 }), now), { dot: 'warn', text: 'Reconnecting…' });
  assert.equal(machineLine(m({ linkDroppedAt: now - RECONNECT_MS }), now).text, 'Online · Claude Code, Codex');
  assert.equal(machineLine(m({ linkDroppedAt: now - 5_000, status: 'offline' }), now).text, 'Offline');
});

test('limit, paused and waiting sit between the network states and Online', () => {
  assert.deepEqual(machineLine(m({ limit: { usd: 20 } }), now), { dot: 'warn', text: 'Limit reached · about $20 today' });
  assert.equal(machineLine(m({ limit: { usd: 4.2 } }), now).text, 'Limit reached · about $4.20 today');
  assert.deepEqual(machineLine(m({ paused: true, waiting: 2 }), now), { dot: 'warn', text: 'Paused · no answer' });
  assert.deepEqual(machineLine(m({ waiting: 2 }), now), { dot: 'warn', text: '2 waiting' });
  assert.equal(machineLine(m({ waiting: 0 }), now).text, 'Online · Claude Code, Codex');
  assert.equal(machineLine(m({ localNetwork: 'denied', limit: { usd: 1 } }), now).text, 'Can’t reach local network');
  assert.equal(machineLine(m({ limit: { usd: 1 }, waiting: 3 }), now).text, 'Limit reached · about $1 today');
});

test('Raise limit is the Mac’s action only', async () => {
  const { TAIL_STATES, LEAD_STATES } = await import('../shared/host/machineLine.mjs');
  const limit = TAIL_STATES.find((s: any) => s.id === 'limit-reached')!;
  const mm = m({ limit: { usd: 20 } });
  assert.deepEqual((limit.line(mm, { now, client: 'mac' }) as any).action, { kind: 'raise-limit', label: 'Raise limit' });
  assert.deepEqual(
    (limit.line(mm, { now }) as any).action,
    { kind: 'raise-limit', label: 'Raise limit' },
    'the Mac, which names no client',
  );
  assert.equal((limit.line(mm, { now, client: 'phone' }) as any).action, undefined);
  const byId = (id: string) => LEAD_STATES.find((s: any) => s.id === id)!;
  assert.deepEqual((byId('deleted-at-provider').line(m(), { now }) as any).action, { kind: 'remove', label: 'Remove' });
  assert.deepEqual((byId('creating').line(m({ cloud: 'creating' }), { now }) as any).action, { kind: 'cancel', label: 'Cancel' });
  assert.deepEqual((byId('asleep').line(m({ cloud: 'asleep', canWake: true }), { now }) as any).action, { kind: 'wake', label: 'Wake' });
  assert.equal((byId('asleep').line(m({ cloud: 'asleep' }), { now }) as any).action, undefined);
});

test('an agent that is ready and others installed but signed out: the line names each, with Sign in for the first (#4931)', () => {
  const mixed = m({
    agents: [
      { id: 'claude', label: 'Claude Code', state: 'ready' },
      { id: 'gemini', label: 'Gemini', state: 'signin' },
      { id: 'grok', label: 'Grok', state: 'signin' },
    ],
  });
  assert.deepEqual(machineLine(mixed, now), { dot: 'ok', text: 'Online · Claude Code · Gemini and Grok need sign-in' });
  assert.deepEqual(
    machineLine(m({ agents: [mixed.agents[0], mixed.agents[1], { id: 'codex', label: 'Codex', state: 'missing' }] }), now).text,
    'Online · Claude Code · Gemini needs sign-in',
    'one agent needs it, and a missing core agent is not a sign-in',
  );
  const ready = TAIL.find((s: any) => s.id === 'ready')!;
  assert.deepEqual((ready.line(mixed, { now }) as any).action, { kind: 'signin', agent: mixed.agents[1], label: 'Sign in' });
  assert.equal((ready.line(m(), { now }) as any).action, undefined, 'every agent ready: nothing to do');
  const checking = m({ agents: [mixed.agents[0], { id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Checking on box…' }] });
  assert.equal(machineLine(checking, now).text, 'Online · Claude Code', 'a read still under way is not a sign-in need');
  assert.equal((ready.line(checking, { now }) as any).action, undefined);
});

test('a lone Checking agent is no sign-in need on the Mac (no line, no button); the phone keeps counting it; long lists say two names and +N (#4949)', () => {
  const checking = m({ agents: [{ id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Checking on box…' }] });
  const signin = TAIL.find((s: any) => s.id === 'signin')!;
  assert.equal(signin.match(checking, { now }), false);
  assert.equal(signin.match(checking, { now, client: 'phone' }), true);
  assert.equal(machineLine(checking, now, 'phone').text, 'Gemini needs sign-in');
  const many = (n: number, ready = true) =>
    m({
      agents: [
        ...(ready ? [{ id: 'claude', label: 'Claude Code', state: 'ready' }] : []),
        ...['Gemini', 'Grok', 'Cursor', 'OpenCode'].slice(0, n).map((label) => ({ id: label.toLowerCase(), label, state: 'signin' })),
      ],
    });
  assert.equal(machineLine(many(4), now).text, 'Online · Claude Code · Gemini, Grok +2 need sign-in');
  assert.equal(machineLine(many(3), now).text, 'Online · Claude Code · Gemini, Grok and Cursor need sign-in');
  assert.equal(machineLine(many(4, false), now).text, 'Gemini, Grok +2 need sign-in');
  assert.equal(machineLine(many(4, false), now, 'phone').text, 'Gemini, Grok, Cursor and OpenCode need sign-in');
});

test('the phone keeps its line for a ready and a signed-out agent: no change of phone words without a device check (#4931)', () => {
  const mixed = m({
    agents: [
      { id: 'claude', label: 'Claude Code', state: 'ready' },
      { id: 'codex', label: 'Codex', state: 'signin', reason: 'Sign in on studio' },
    ],
  });
  assert.deepEqual(machineLine(mixed, now, 'phone'), { dot: 'ok', text: 'Online · Claude Code' });
  assert.equal(machineLine(mixed, now, 'mac').text, 'Online · Claude Code · Codex needs sign-in');
  const ready = TAIL.find((s: any) => s.id === 'ready')!;
  assert.equal((ready.line(mixed, { now, client: 'phone' }) as any).action, undefined);
});

test('usdText', () => {
  assert.equal(usdText(20), '$20');
  assert.equal(usdText(4.2), '$4.20');
});
