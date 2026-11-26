// MoMo's home composed on the phone itself, for when no Mac answers: the shared home (shared/momoHomeReal.mjs, the one the Mac runs) over the phone's own Host sessions and sealed memory, offered through the same channel the Mac's service gives (`momo.home.view`, `momo.home.intent`, `momo.home.google` and the event `momo.home.changed`), so the screens and the store cannot tell which one they read. The phone looks at every Host, fences with the shared rules and asks the owner for every choice, exactly as the Mac does.
import { createRealHome } from '../../../../shared/momoHomeReal.mjs';
import { createMomoOutbox } from '../../../../shared/momoOutbox.mjs';
import { say } from '../say';
import { CHANGED_EVENT, INTENT_METHOD, VIEW_METHOD, type Channel } from '../transport';
import { keepGranted } from './grants';
import { handedOff } from './handOff';
import { phoneMomoHosts, type PhoneSessions } from './hosts';
import type { openPhoneHomeMemory } from './memory';

type Memory = Awaited<ReturnType<typeof openPhoneHomeMemory>>;

/** `momo.home.google`: the phone's Google steps, relayed to the home's Host as the Mac relays them. */
export const GOOGLE_METHOD = 'momo.home.google';

export function createPhoneHome(o: {
  sessions: PhoneSessions;
  account: () => string | null;
  /** Tells when a machine's answer changed (a machine came back, went away). */
  onChange: (fn: () => void) => () => void;
  memory: Memory;
  newId: () => string;
  now?: () => number;
  /** How the grant's 30 minutes are waited: returns the way to stop (the clock's own by default). */
  every?: (fn: () => void, ms: number) => () => void;
  report?: (error: unknown) => void;
}) {
  const now = o.now ?? Date.now;
  const base = phoneMomoHosts({ sessions: o.sessions, account: o.account, onChange: o.onChange });
  /** The machines that refused the grant last time (until one is taken): said in the view, as the Mac's own grant failures are, with the one way on. */
  const refused = new Set<string>();
  const hosts = {
    ...base,
    grant: async (id: string) => {
      try {
        await base.grant(id);
        refused.delete(id);
      } catch (error) {
        refused.add(id);
        throw error;
      }
    },
  };
  // made inert: nothing listens to the machines, runs a timer or tells a Host until `start()`, so a composition that is made and not used (a render that was thrown away) costs and does nothing
  let deliver: (() => void) | null = null;
  const real = createRealHome({
    hosts: {
      ...hosts,
      onChange: (fn: () => void) => {
        deliver = fn;
        return () => void (deliver = null);
      },
    },
    now,
    seen: o.memory.seen,
    kept: o.memory.kept,
    memory: o.memory.memory,
    outbox: createMomoOutbox({ store: o.memory.outbox, now }),
    sent: o.memory.sent,
    newId: o.newId,
    report: o.report ?? (() => undefined),
    // starting, moving, standing down and resetting stay with the Mac: the steps of the shared rules are not run here
    handOff: say('doThisOnYourMac'),
  });
  const every =
    o.every ??
    ((fn: () => void, ms: number) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    });
  const { api } = real;
  const intent = async (raw: { kind?: string; id?: unknown } | undefined) =>
    // what only a Mac does is said in place, with no request: the screens stay and the action hands off
    handedOff(raw)
      ? { ok: false, cause: say('doThisOnYourMac') }
      : withKept((await api.intent(raw)) as { ok?: boolean; view?: { problems?: unknown[] } });
  /** What the phone kept for MoMo cannot be read: said in the view, with the one choice, and nothing new is taken while nothing can be kept. */
  const KEPT = say('phoneKeptUnreadable');
  const DISCARD = { id: 'discard-phone-memory', label: say('deleteIt') };
  /** The view with what this phone cannot know taken out: which agents are signed in on a machine whose agents it has not read, and the fix of an agent problem (the Mac's to run). */
  type Homeish = {
    view?: {
      home?: { homeMachineId?: string | null; machines: { machineId: string; agentsSignedIn?: string[] }[]; agentProblem?: object | null };
    };
  };
  const own = <T extends Homeish>(payload: T): T => {
    const home = payload.view?.home;
    if (!home) return payload;
    const machines = home.machines.map((m) => (o.sessions.agents(m.machineId) === null ? { ...m, agentsSignedIn: [] } : m));
    const agentProblem = home.agentProblem ? { ...home.agentProblem, fix: null } : null;
    return { ...payload, phoneOwn: true, view: { ...payload.view, home: { ...home, machines, agentProblem } } };
  };
  const withKept = <T extends Homeish & { view?: { problems?: unknown[] } }>(raw: T): T => {
    const payload = own(raw);
    const problems: unknown[] = [];
    const names = hosts
      .machines()
      .filter((m) => refused.has(m.id))
      .map((m) => m.name);
    if (names.length)
      problems.push({
        id: 'phone-grant',
        code: 'grant_refused',
        cause: say('grantRefused', { names: names.join(' and ') }),
        fix: { id: 'check-again', label: say('checkAgain') },
        since: null,
      });
    if (o.memory.unreadable) problems.push({ id: 'phone-memory', code: 'phone_memory_unreadable', cause: KEPT, fix: DISCARD, since: null });
    const shared = (payload.view?.problems ?? []) as unknown[];
    return problems.length ? { ...payload, view: { ...payload.view, problems: [...shared, ...problems] } } : payload;
  };
  const view = async () => withKept(await api.view());
  const unreadableIntent = async (raw: { kind?: string; id?: unknown } | undefined) => {
    if (raw?.kind === 'fix' && raw.id === DISCARD.id) {
      await o.memory.discard();
      return { ok: true, ...(await view()) };
    }
    if (o.memory.unreadable && raw?.kind === 'send')
      return { ok: false, cause: KEPT, fix: { kind: 'fix', id: DISCARD.id }, fixLabel: DISCARD.label };
    return null;
  };
  const channel: Channel = {
    request: async (method, params) => {
      if (method === VIEW_METHOD) return view();
      if (method === INTENT_METHOD) {
        const raw = params.intent as Parameters<typeof intent>[0];
        return (await unreadableIntent(raw)) ?? intent(raw);
      }
      if (method === GOOGLE_METHOD) return api.hostCall('host.momoGoogle', params);
      throw new Error(`Unknown request: ${method}`);
    },
    onEvent: (listener) => api.onChanged((payload: Record<string, unknown>) => listener({ ...withKept(payload), ev: CHANGED_EVENT })),
  };
  let stop: (() => void) | null = null;
  return {
    channel,
    /** Starts listening to the machines and keeping the grant up (every machine is told the account may see MoMo, now and every 30 minutes: a Host that restarted has none). */
    start() {
      if (stop) return;
      const stopChange = o.onChange(() => deliver?.());
      const stopGrants = keepGranted({
        machines: hosts.machines,
        grant: hosts.grant,
        refresh: () => real.refresh(),
        onChange: o.onChange,
        now,
        every,
        report: o.report,
      });
      stop = () => {
        stopGrants();
        stopChange();
      };
    },
    /** Asks the Hosts again at once and tells whoever listens. */
    refresh: () => real.refresh(),
    /** The home is stopped: nothing it still has under way writes or tells anyone. */
    dispose: () => {
      stop?.();
      stop = null;
      real.dispose();
    },
    /** Reset MoMo: nothing is remembered. */
    forget: () => real.forget(),
  };
}
