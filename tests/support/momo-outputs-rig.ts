// The rig of MoMo's Outputs tests (#2139): a real OutputsStore over a scratch MoMo folder, and the real trust gate, sentinel, audit log and capability registry around the Outputs tools, shared by the tests/momoOutputs*.test.ts and tests/momoSheet.test.ts files.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditLog, fakeSafe, scratch } from './momo-trust.ts';

const require = createRequire(import.meta.url);
const { OutputsStore } = require('../../electron/momo/outputs.cjs');
const { registerOutputsTools, SOURCE } = require('../../electron/momo/outputsTools.cjs');
const { Registry } = require('../../electron/capabilities/contract/registry.cjs');
const { Sentinel } = require('../../electron/momo/sentinel.cjs');
const { createTrustGate } = require('../../electron/momo/trustGate.cjs');
const { CURRENT } = require('../../electron/momo/audit.cjs');

export const store = (o: { now?: () => number } = {}) => {
  const dir = scratch();
  let n = 0;
  const safe = fakeSafe();
  return { dir, safe, s: new OutputsStore({ dir, safeStorage: safe, now: o.now ?? (() => 1000), newId: () => `o${++n}` }) };
};

export function rig(
  o: { level?: 'read' | 'ask' | 'blocked'; sandbox?: boolean; flag?: { on: boolean }; before?: () => void; now?: () => number } = {},
) {
  const { dir, safe, s } = store();
  const a = auditLog({ safe });
  const cards: any[] = [];
  const sentinel = new Sentinel({
    askUser: async (card: any) => {
      cards.push(card);
      return { allow: true, scope: 'once' };
    },
    allowed: () => true,
  });
  sentinel.setSource(SOURCE, { level: o.level ?? 'ask', private: false, name: 'MoMo files' });
  const trust = createTrustGate({ sentinel, audit: a.log });
  const registry = new Registry();
  const momo = new Set(['momo-main']);
  const off = registerOutputsTools(registry, {
    store: s,
    trust: (call: any, exec: any, opts: any) => {
      o.before?.();
      return trust(o.sandbox === false ? { ...call, sandbox: false } : call, exec, opts);
    },
    now: o.now,
    tainted: (id: string) => sentinel.tainted(id),
    enabled: () => (o.flag ?? { on: true }).on,
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
  return { dir, s, safe, sentinel, cards, run, entries, registry, off };
}
