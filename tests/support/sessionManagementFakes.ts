// Stand-ins for the session-management tests: a small linked family (top > alpha > gamma, beside an unlinked chat), the
// orchestrator surface the tools read, and a session host that records what the tools asked of it, per harness kind.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../../electron/capabilities/contract/registry.cjs');
const { registerSessionControlTools } = require('../../electron/capabilities/tools/sessionControl.cjs');

export type Kind = 'codex' | 'claude' | 'acp:kimi';
export const KINDS: Kind[] = ['codex', 'claude', 'acp:kimi'];

/** top started alpha, alpha started gamma; `solo` is linked to none of them. */
export function family(opts: { states?: Record<string, string>; archived?: string[]; detached?: string[] } = {}) {
  const children: Record<string, any> = {
    alpha: { parentId: 'top', name: 'alpha', title: 'Alpha task', cwd: '/w/alpha' },
    gamma: { parentId: 'alpha', name: 'gamma', title: 'Gamma task', cwd: '/w/gamma' },
  };
  for (const id of opts.detached ?? []) children[id].detached = true;
  const archived = new Set(opts.archived ?? []);
  const states = opts.states ?? {};
  const journal: any = {
    data: { dependants: {}, queue: [] },
    child: (id: string) => children[id] ?? null,
    childrenOf: (id: string) => Object.keys(children).filter((c) => children[c].parentId === id),
    parent: () => null,
    change: (fn: (d: any) => void) => fn({ children, dependants: {}, queue: [] }),
  };
  const turnOf = (id: string) => states[id] ?? 'idle';
  const controller = {
    state: { get: (id: string) => ({ turn: turnOf(id), queue: [] }) },
  };
  const calls: any[] = [];
  const orchestrator: any = {
    unavailable: null,
    journal,
    o: { controller, kinds: () => ['codex', 'claude', 'acp:kimi'], usable: async (k: string) => k !== 'acp:kimi' },
    archived: (id: string) => archived.has(id),
    detach: (id: string) => (calls.push(['detach', id]), { detached: true }),
    pump: () => calls.push(['pump']),
    safely: (what: string, fn: () => void) => {
      try {
        fn();
        return true;
      } catch (error) {
        calls.push(['noted', what, (error as Error).message]);
        return false;
      }
    },
  };
  return { orchestrator, children, archived, states, calls };
}

/** What the tools ask of main, answered from `facts` per chat id and recorded in `log`. */
export function fakeHost(facts: Record<string, any>, log: any[] = []) {
  const settings = (id: string) => facts[id]?.settings ?? null;
  const host: any = {
    describe: async (id: string) => facts[id]?.describe ?? null,
    history: async (id: string) => {
      const h = facts[id]?.history;
      if (h instanceof Error) throw h;
      return h ?? null;
    },
    usage: async (id: string) => facts[id]?.usage ?? null,
    exportTranscript: async (id: string) => (log.push(['export', id]), facts[id]?.export ?? null),
    startTargets: async (id: string) => (log.push(['targets', id]), { harnesses: [], thisChat: { harness: 'codex' }, projects: [] }),
    noteChapter: async (id: string, c: any) => log.push(['chapter', id, c]),
    settingsOf: async (id: string) => settings(id),
    setTitle: async (id: string, t: string) => log.push(['title', id, t]),
    unarchive: async (id: string) => log.push(['unarchive', id]),
    remove: async (id: string) => {
      log.push(['remove', id]);
      if (facts[id]?.removeFails) throw new Error('the harness refused');
    },
    setModel: async (id: string, m: string) => (log.push(['model', id, m]), { model: m }),
    refuseWhileSwitching: (id: string) => {
      if (facts[id]?.switching) throw Object.assign(new Error('Call set_session_harness again.'), { code: 'switch_pending' });
    },
    selectsModel: (kind: string) => !kind.startsWith('acp:'),
    switchHarness: async (id: string, wanted: any) => (
      log.push(['harness', id, wanted]), { model: null, ...wanted, effort: wanted.effort ?? wanted.inheritedEffort ?? null }
    ),
    setEffort: async (id: string, e: string) => (log.push(['effort', id, e]), { effort: facts[id]?.appliedEffort ?? e }),
    setFast: async (id: string, on: boolean) => (log.push(['fast', id, on]), on),
    setPermission: async (id: string, mode: string) => (log.push(['permission', id, mode]), { mode: facts[id]?.appliedMode ?? mode }),
  };
  return host;
}

/** A registry that approves (or not) every irreversible call, and the call helper for a chat. */
export function registryFor(approve: boolean | ((req: any) => boolean) = true) {
  const asked: any[] = [];
  const r = new Registry({
    approve: (req: any) => {
      asked.push(req);
      return typeof approve === 'function' ? approve(req) : approve;
    },
  });
  const call = (chat: string, tool: string, args: any = {}) => r.invoke(chat, 'seg', tool, args);
  return { r, call, asked };
}

/** The text of a tool result, or its error message. */
export function textOf(res: any): string {
  if (!res.ok) return `ERROR ${res.error?.code}: ${res.error?.message ?? ''}`;
  return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
}

export const settingsFor = (kind: Kind, o: Record<string, any> = {}) => ({
  kind,
  family: kind.split(':')[0],
  model: null,
  effort: null,
  permission: 'default',
  fast: kind === 'acp:kimi' ? undefined : false,
  ...o,
});

export const owner = (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null);

/** top (the caller, on `mine`) started alpha (on `theirs`), which started gamma. */
export function controlSetup(
  mine: Kind = 'claude',
  theirs: Kind = 'claude',
  o: {
    top?: any;
    alpha?: any;
    archived?: string[];
    states?: Record<string, string>;
    approve?: boolean;
    facts?: Record<string, any>;
    detached?: string[];
  } = {},
) {
  const fam = family({ archived: o.archived, states: o.states, detached: o.detached });
  const log: any[] = [];
  const facts: Record<string, any> = {
    top: {
      describe: { title: 'Top' },
      settings: settingsFor(mine, {
        model: 'opus',
        effort: 'high',
        permission: 'auto-review',
        fast: mine === 'acp:kimi' ? undefined : true,
        ...o.top,
      }),
    },
    alpha: {
      describe: { title: 'Alpha task' },
      settings: settingsFor(theirs, { model: 'haiku', effort: 'low', permission: 'default', ...o.alpha }),
    },
    gamma: { describe: { title: 'Gamma task' }, settings: settingsFor('codex') },
    ...o.facts,
  };
  const host = fakeHost(facts, log);
  const { r, call, asked } = registryFor(o.approve ?? true);
  registerSessionControlTools(r, { orchestrator: fam.orchestrator, owner, host });
  return { ...fam, host, r, call, asked, log, facts };
}
