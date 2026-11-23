// Test world for MoMo tasks: scripted machines, brain, chat and clock around the real manager, store and watch logic.
import { createTaskManager, type ManagerPorts, type WatchReader } from '../../../shared/momoTasks/manager.ts';
import { words } from './words.ts';
import { createItemStore, createMemorySeam } from '../../../shared/momoTasks/store.ts';
import type { MachineInfo, Probe, ResultCard, StartOutcome, StartRequest, WatchNotice } from '../../../shared/momoTasks/types.ts';
import type { Reading } from '../../../shared/momoTasks/watch.ts';

export const machine = (
  machineId: string,
  name: string,
  over: Omit<Partial<MachineInfo>, 'agents'> & { agents?: Record<string, 'ready' | 'signin' | 'missing'> } = {},
): MachineInfo => {
  const { agents = { claude: 'ready', codex: 'ready', 'acp:gemini': 'ready' }, ...rest } = over;
  return {
    machineId,
    name,
    online: true,
    outdated: false,
    installable: true,
    agents: Object.entries(agents).map(([id, state]) => ({ id, state })),
    ...rest,
  };
};

export const HOME = { machineId: 'home', harness: 'claude' };

export function world(
  opts: {
    machines?: MachineInfo[];
    home?: { machineId: string; harness: string };
    now?: number;
    withReader?: boolean;
    seam?: ReturnType<typeof createMemorySeam>;
  } = {},
) {
  let now = opts.now ?? Date.parse('2026-11-23T10:00:00Z');
  let n = 0;
  const seam = opts.seam ?? createMemorySeam();
  const clock = { now: () => now };
  const store = createItemStore(seam, clock);
  const w = {
    machines: opts.machines ?? [machine('home', 'Studio'), machine('mini', 'Mac mini'), machine('mac', 'This Mac')],
    started: [] as StartRequest[],
    stopped: [] as [string, string][],
    startOutcome: null as null | ((req: StartRequest) => StartOutcome | Promise<StartOutcome>),
    stopThrows: false,
    probes: new Map<string, Probe | Error>(),
    cards: [] as ResultCard[],
    notices: [] as WatchNotice[],
    postFails: 0,
    noticeFails: false,
    asked: [] as string[],
    askedData: [] as (string | undefined)[],
    answer: ((): string => '{"met": true, "reason": "ok", "checked": "opened the file, totals match"}') as () => string | Promise<string>,
    readOnly: true,
    readings: [] as (Reading | Error)[],
    reads: 0,
    readGate: null as null | Promise<void>,
    probeGate: null as null | Promise<void>,
    listGate: null as null | Promise<void>,
    stopGate: null as null | Promise<void>,
  };
  const reader: WatchReader = {
    toolIsReadOnly: async () => w.readOnly,
    read: async () => {
      w.reads++;
      if (w.readGate) await w.readGate;
      const next = w.readings.shift();
      if (next instanceof Error) throw next;
      return next ?? { fingerprint: 'same' };
    },
  };
  const ports: ManagerPorts = {
    store,
    clock,
    words,
    randomId: () => `id${++n}`,
    home: async () => opts.home ?? HOME,
    machines: {
      list: async () => {
        if (w.listGate) await w.listGate;
        return w.machines;
      },
      start: async (req) => {
        w.started.push(req);
        return w.startOutcome ? w.startOutcome(req) : { ok: true, sessionId: `sess${w.started.length}` };
      },
      stop: async (m, s) => {
        w.stopped.push([m, s]);
        if (w.stopGate) await w.stopGate;
        if (w.stopThrows) throw new Error('unreachable');
      },
      probe: async (m, s) => {
        if (w.probeGate) await w.probeGate;
        const p = w.probes.get(`${m}/${s}`) ?? { state: 'running' as const };
        if (p instanceof Error) throw p;
        return p;
      },
    },
    check: { ask: async (prompt, data) => (w.asked.push(prompt), w.askedData.push(data), w.answer()) },
    chat: {
      postResult: async (card) => {
        if (w.postFails > 0) {
          w.postFails--;
          throw new Error('chat down');
        }
        w.cards.push(card);
      },
      postWatchChanged: async (notice) => {
        if (w.noticeFails) throw new Error('chat down');
        w.notices.push(notice);
      },
    },
    ...(opts.withReader === false ? {} : { watches: reader }),
  };
  const mgr = createTaskManager(ports);
  return { w, mgr, store, seam, advance: (ms: number) => (now += ms), setNow: (t: number) => (now = t), clock };
}

export const ask = {
  title: 'Build the Acme quote sheet',
  doneMeans: 'Sheet has 200 seats at $48k and opens without errors',
  origin: 'asked' as const,
  userStarted: true,
};
export const REPORT = 'Result: Built Acme-quote.xlsx for 200 seats.\nFiles: Acme-quote.xlsx\nEvidence: opened it, totals match $48k.';

export const gate = () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  return { hold, release };
};
export const tick = () => new Promise((r) => setImmediate(r));
