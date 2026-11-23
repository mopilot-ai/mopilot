// What a machine's page shows beyond its row (X2): the devices its Host knows, the owner's rules, the day's spend, the last audit lines and what the organization locks. Each comes from its own call in the main process (F1 clients, U2 policy, U5 spend, W3 audit, W2 managed policy); a call this build does not have, or a Host that does not answer, leaves that part out and the page leaves the section out. The owner's rules are the one write: every control sends the whole document and shows what main kept.
import { useState } from 'react';
import { native } from './native';
import { ignoring } from './ignored';

/** A client the Host knows: this Mac, another Mac, a phone, the CLI. `pairId` is set for a phone that can be offered direct access. */
export type MachineDevice = {
  id: string;
  name: string;
  kind: 'desktop' | 'phone' | 'cli' | 'other';
  /** this Mac itself: its row says so and has no Remove */
  thisMac: boolean;
  addedAt: number | null;
  /** a phone only: whether it uses this Host on its own (`on`), was offered (`offered`) or is not set up (`off`) */
  direct?: { pairId: string; state: 'off' | 'offered' | 'on' };
};

export type MachineRules = {
  permissionMax: 'read-only' | 'default' | 'auto-review' | 'full-access';
  pauseMinutes: number;
  notify: {
    needsYou: boolean;
    done: boolean;
    paused: boolean;
    detail: 'minimal' | 'tool' | 'full';
    quiet: { start: string; end: string; tz: string } | null;
  };
};

export type MachineSpend = { dayUsd: number; dayLimitUsd: number | null; chatLimitUsd: number | null; unpriced: boolean };
/** `whoKind` is the kind of client the Host names (`phone`, `desktop`, `cli`), when it says. */
export type MachineAuditLine = { at: number; kind: string; who: string; whoKind?: string };
/** What the organization's managed policy locks: its name and the keys it fixes (a key is a section's control). */
export type MachineManaged = { org: string; locked: string[] };

export type MachinePageData = {
  devices?: MachineDevice[];
  /** the owner's document as main keeps it: a control rewrites one key and sends the whole */
  ownerDoc?: OwnerDoc;
  rules?: MachineRules;
  spending?: MachineSpend;
  activity?: MachineAuditLine[];
  managed?: MachineManaged;
};

/** The calls of other packages, each present only when its package is in this build. */
type Calls = {
  clients?: (id: string) => Promise<unknown>;
  ownerPolicy?: () => Promise<unknown>;
  setOwnerPolicy?: (doc: unknown) => Promise<unknown>;
  hostStatus?: (id: string) => Promise<unknown>;
  audit?: (id: string) => Promise<unknown>;
  phoneDirectList?: (id: string) => Promise<unknown>;
  phoneDirectSet?: (id: string, pairId: string, on: boolean) => Promise<unknown>;
  removeClient?: (machineId: string, clientId: string) => Promise<unknown>;
};
const calls = (): Calls => native.host as unknown as Calls;

/** The owner's document: a bag of keys the page edits one at a time. */
export type OwnerDoc = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** `v` as an object, an empty one when it is not. */
export const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const DIRECT = ['off', 'offered', 'on'] as const;
const KINDS = ['desktop', 'phone', 'cli'] as const;
const CEILINGS = ['read-only', 'default', 'auto-review', 'full-access'] as const;

/** The Host's client records as devices, one per client, a bad record dropped. */
export function readDevices(v: unknown): MachineDevice[] | undefined {
  const list = isObj(v) ? v.clients : v;
  if (!Array.isArray(list)) return undefined;
  const out = list.flatMap((raw): MachineDevice[] => {
    const c = obj(raw);
    if (typeof c.id !== 'string' || typeof c.name !== 'string' || !c.name) return [];
    return [
      {
        id: c.id,
        name: c.name,
        kind: KINDS.find((k) => k === c.kind) ?? 'other',
        thisMac: c.self === true,
        addedAt: num(c.addedAt),
      },
    ];
  });
  return out.length ? out : undefined;
}

/** The owner's document as the rules the page edits, or undefined when it is not one. */
export function readRules(v: unknown): MachineRules | undefined {
  if (!isObj(v) || !isObj(v.approvals) || !isObj(v.notify)) return undefined;
  const n = v.notify;
  const q = obj(n.quiet);
  return {
    permissionMax: CEILINGS.find((c) => c === v.permissionMax) ?? 'full-access',
    pauseMinutes: num(v.approvals.pauseMinutes) ?? 30,
    notify: {
      needsYou: n.needsYou !== false,
      done: n.done === true,
      paused: n.paused !== false,
      detail: n.detail === 'minimal' || n.detail === 'full' ? n.detail : 'tool',
      quiet: typeof q.start === 'string' && typeof q.end === 'string' ? { start: q.start, end: q.end, tz: String(q.tz ?? '') } : null,
    },
  };
}

/** The Host's `spend` and the owner's limits as the Spending section's numbers. */
export function readSpend(status: unknown, doc: unknown): MachineSpend | undefined {
  const s = obj(obj(status).spend);
  const dayUsd = num(s.dayUsd);
  if (dayUsd === null) return undefined;
  const limits = obj(obj(doc).spend);
  return {
    dayUsd,
    dayLimitUsd: num(s.dayLimitUsd) ?? num(limits.dayUsd),
    chatLimitUsd: num(limits.chatUsd),
    unpriced: Number(s.unpriced) > 0,
  };
}

/** The managed layer's name and locked keys from `host.status`, absent for a person. */
export function readManaged(status: unknown): MachineManaged | undefined {
  const p = obj(obj(status).policy);
  if (p.managed !== true) return undefined;
  return {
    // the Host names the organization `organization` and a key by its path (`approvals.pauseMinutes`); a section's control is the first part
    org:
      typeof p.organization === 'string' && p.organization
        ? p.organization
        : typeof p.org === 'string' && p.org
          ? p.org
          : 'your organization',
    locked: Array.isArray(p.locked)
      ? [...new Set(p.locked.filter((k): k is string => typeof k === 'string').map((k) => k.split('.')[0]))]
      : [],
  };
}

/** The last audit lines, newest first, at most 50. */
export function readAudit(v: unknown): MachineAuditLine[] | undefined {
  const list = isObj(v) ? v.lines : v;
  if (!Array.isArray(list)) return undefined;
  const out = list.flatMap((l): MachineAuditLine[] =>
    isObj(l) && typeof l.at === 'number' && typeof l.kind === 'string'
      ? [
          {
            at: l.at,
            kind: l.kind,
            who: typeof l.who === 'string' ? l.who : '',
            ...(typeof l.whoKind === 'string' ? { whoKind: l.whoKind } : {}),
          },
        ]
      : [],
  );
  return out.length ? out.slice(0, 50) : undefined;
}

/** Everything the page has data for; a call that is missing or fails leaves its part out. @param id the machine */
export async function loadMachinePage(id: string): Promise<MachinePageData> {
  const c = calls();
  const ask = async (fn: ((...a: never[]) => Promise<unknown>) | undefined, ...args: unknown[]) => {
    if (typeof fn !== 'function') return undefined;
    try {
      return await fn.apply(native.host, args as never[]);
    } catch (e) {
      ignoring('read a machine page part')(e);
      return undefined;
    }
  };
  const [clients, doc, status, audit, direct] = await Promise.all([
    ask(c.clients, id),
    ask(c.ownerPolicy),
    ask(c.hostStatus, id),
    ask(c.audit, id),
    ask(c.phoneDirectList, id),
  ]);
  const devices = readDevices(clients)?.map((d) => {
    const mine = Array.isArray(direct) ? obj(direct.find((p) => obj(p).fingerprint === d.id)) : {};
    const state = DIRECT.find((x) => x === mine.state);
    return d.kind === 'phone' && state ? { ...d, direct: { pairId: String(mine.pairId), state } } : d;
  });
  const rules = readRules(doc);
  return {
    ...(devices ? { devices } : {}),
    ...(rules ? { rules, ownerDoc: obj(doc) } : {}),
    ...(readSpend(status, doc) ? { spending: readSpend(status, doc) } : {}),
    ...(readAudit(audit) ? { activity: readAudit(audit) } : {}),
    ...(readManaged(status) ? { managed: readManaged(status) } : {}),
  };
}

/** The owner's document with one change: `set` gets a copy of it and edits it. Sent whole; resolves what main kept, rejects with its refusal. */
export async function saveOwnerDoc(doc: OwnerDoc, set: (copy: OwnerDoc) => void): Promise<OwnerDoc> {
  const send = calls().setOwnerPolicy;
  if (typeof send !== 'function') throw new Error('This version cannot change the rules.');
  const copy = structuredClone(doc);
  set(copy);
  const kept = (await send.call(native.host, copy)) as { doc?: unknown } | undefined;
  return isObj(kept?.doc) ? kept.doc : copy;
}

/** Takes a device off the machine: its Host stops it at once. */
export async function removeDevice(machineId: string, deviceId: string): Promise<void> {
  const remove = calls().removeClient;
  if (typeof remove !== 'function') throw new Error('This version cannot remove a device.');
  await remove.call(native.host, machineId, deviceId);
}

/** The phone's switch: offer it direct access to the machine, or take it back. */
export async function setPhoneDirect(machineId: string, pairId: string, on: boolean): Promise<void> {
  const set = calls().phoneDirectSet;
  if (typeof set !== 'function') throw new Error('This version cannot set up direct access.');
  await set.call(native.host, machineId, pairId, on);
}

/** Whether a rule's control is the organization's: a locked key is shown disabled with who set it. */
export const isLocked = (managed: MachineManaged | undefined, key: string): boolean => !!managed && managed.locked.includes(key);

/** Whether Settings opens a machine's page from its row (`host.machinePage`), read from the app's flags when the row first draws (a flag does not change while Settings is open); false where the app has none. */
export function useMachinePageFlag(): boolean {
  const [on] = useState(() => {
    try {
      return native.flags.isEnabled('host.machinePage') === true;
    } catch {
      return false;
    }
  });
  return on;
}
