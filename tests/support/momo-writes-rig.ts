// The rig of MoMo's write tests (#2139 P5): the real trust gate, sentinel, audit log, approval card broker, sources hub and write ledger over a fake EventKit helper, shared by tests/momoWrites.test.ts and tests/momoWritesUndo.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditLog } from './momo-trust.ts';
import { hubFixture } from './momo-sources.ts';
import { waitFor } from './waitFor.ts';

const require = createRequire(import.meta.url);
const { createMomoActionAsk } = require('../../electron/momo/actionAsk.cjs');
const { ApprovalBroker } = require('../../electron/capabilities/contract/approvals.cjs');
const { Registry } = require('../../electron/capabilities/contract/registry.cjs');
const { Sentinel } = require('../../electron/momo/sentinel.cjs');
const { createTrustGate } = require('../../electron/momo/trustGate.cjs');
const { CURRENT } = require('../../electron/momo/audit.cjs');
const { createEventKit } = require('../../electron/momo/sources/eventKit.cjs');
const { createWriter } = require('../../electron/momo/sources/write.cjs');
const { registerWriteTools } = require('../../electron/momo/sources/writeTools.cjs');
const { WriteLedger } = require('../../electron/momo/sources/writeLedger.cjs');

export const NOW = new Date(2026, 9, 23, 15, 30).getTime();
export const EVENT = 'momo_calendar_create_event';
export const ADD = 'momo_reminders_add';
export const DONE = 'momo_reminders_complete';
export const UNDO = 'momo_undo_write';

export async function until(cond: () => boolean) {
  await waitFor(cond, 'the condition');
  assert.ok(cond(), 'timed out');
}

/** A helper error as the helper reports one: with a reason. */
export const helperError = (reason: string, message = reason) => Object.assign(new Error(message), { reason });

export function rig(o: { level?: 'read' | 'ask' | 'blocked'; helper?: null; now?: () => number } = {}) {
  const f = hubFixture({ now: o.now ?? (() => NOW) });
  const clock = { now: NOW };
  const cards: any[] = [];
  const broker = new ApprovalBroker({
    controller: { addApproval: (chatId: string, a: any) => cards.push({ chatId, ...a }), resolveApproval: () => true },
  });
  let sentinel: any;
  const asks = createMomoActionAsk({
    broker: () => broker,
    harnessOf: () => 'claude',
    sourceName: (id: string) => sentinel.sources.get(id)?.name,
  });
  sentinel = new Sentinel({ askUser: asks.askUser, allowed: () => true });
  const a = auditLog();
  const trust = createTrustGate({ sentinel, audit: a.log });
  const audit = a.log;
  for (const id of ['calendar', 'reminders']) {
    f.hub.connect(id);
    f.hub.setLevel(id, o.level ?? 'ask');
  }
  const changes: number[] = [];
  const calls: { method: string; params: any }[] = [];
  const fail: Record<string, unknown> = {};
  const made = { n: 0 };
  const helper = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (fail[method]) throw fail[method];
      if (method === 'calendar.calendars') return { items: [{ id: 'cal-work', title: 'Work', account: 'iCloud' }] };
      if (method === 'reminders.lists') return { items: [{ id: 'list-home', title: 'Home', account: 'iCloud' }] };
      if (method === 'calendar.create') return { id: `ev-${++made.n}`, calendar: 'Work' };
      if (method === 'reminders.create') return { id: `rem-${++made.n}`, list: 'Home' };
      if (method === 'reminders.get')
        return {
          id: params.id,
          title: params.id === 'done-1' ? 'Old' : 'Call landlord',
          list: params.id === 'nolist' ? '' : 'Home',
          done: params.id === 'done-1',
        };
      return { ok: true };
    },
  };
  const ledger = new WriteLedger({ dir: f.dir, safeStorage: f.safe, now: () => clock.now, newId: () => `w${++made.n}` });
  ledger.on('changed', () => void changes.push(1));
  const writer = createWriter({
    hub: f.hub,
    eventKit: createEventKit(o.helper === null ? null : helper),
    ledger,
    trust,
    sentinel,
    audit: a.log,
  });
  const registry = new Registry();
  const momo = new Set(['momo-main']);
  const off = registerWriteTools(registry, {
    writer,
    allowed: () => true,
    isMomoChat: (id: string) => momo.has(id),
    owner: (ctx: any) => ctx.chatId || null,
  });
  const run = (tool: string, args: any, chatId = 'momo-main', signal?: AbortSignal) =>
    registry.tools.get(tool).handler(args, { chatId, segmentId: 's', signal });
  const entries = () =>
    fs.existsSync(path.join(a.dir, CURRENT))
      ? fs
          .readFileSync(path.join(a.dir, CURRENT), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const allow = async (p: Promise<unknown>, scope = 'once') => {
    const n = cards.length;
    await until(() => cards.length > n);
    broker.answer(cards[n].id, { decision: 'allow', scope });
    return p;
  };
  const wrote = () => calls.filter((c) => /create|complete|delete/.test(c.method));
  return {
    trust,
    audit,
    changes,
    f,
    cards,
    broker,
    run,
    entries,
    allow,
    calls,
    fail,
    ledger,
    writer,
    registry,
    off,
    clock,
    wrote,
    sentinel,
  };
}
