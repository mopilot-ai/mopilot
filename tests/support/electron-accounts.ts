// Shared fakes for electron/identity/codexAccounts.cjs tests: a scripted Codex app-server process (no binary is
// spawned), a fake relay, a fake main app-server connection and temp CODEX_HOME / userData folders.
// Import this before anything that loads accounts.cjs: it installs the module mocks.
import { mock } from 'node:test';
import type { TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './computerHistory.ts';

export { sealedAuth, sealedAfterSidecar } from './sealedAuth.ts';

/** Returned by a handler: the request is never answered. */
export const NEVER = Symbol('never');
type Handler = (method: string, params: any, home: string) => any;
const defaultHandle: Handler = (method) => {
  switch (method) {
    case 'account/read':
      return { account: { email: 'side@example.com', planType: 'pro' } };
    case 'account/rateLimits/read':
      return { rateLimits: { primary: { usedPercent: 30, resetsAt: 9e9 } } };
    case 'account/login/start':
      return { loginId: 'L1', authUrl: 'https://auth.example.com/start' };
    default:
      return {};
  }
};
export const codex = { handle: defaultHandle as Handler, procs: [] as FakeProc[], spawnFail: false };

export class FakeProc extends EventEmitter {
  pid: number | undefined = 4242;
  written: any[] = [];
  killed = false;
  stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  /** What the code under test registered on stdin, by event. */
  stdinHandlers: Record<string, (...args: any[]) => void> = {};
  stdin = {
    on: (event: string, fn: (...args: any[]) => void) => {
      this.stdinHandlers[event] = fn;
    },
    write: (line: string) => {
      const m = JSON.parse(line);
      this.written.push(m);
      if (m.id === undefined || !m.method) return;
      setImmediate(async () => {
        try {
          const result = await codex.handle(m.method, m.params, this.home);
          if (result === NEVER) return;
          if (result?.__error) return this.send({ id: m.id, error: result.__error });
          this.send({ id: m.id, result });
        } catch (e: any) {
          this.send({ id: m.id, error: { message: e.message } });
        }
      });
    },
  };
  home: string;
  constructor(home: string) {
    super();
    this.home = home;
  }
  send(obj: object) {
    this.stdout.emit('data', JSON.stringify(obj) + '\n');
  }
  kill() {
    this.killed = true;
    setImmediate(() => {
      this.emit('exit', 0);
      this.emit('close', 0);
    });
  }
}

const realCp = createRequire(import.meta.url)('node:child_process');
const fakeCp = {
  ...realCp,
  spawn: (_cmd: string, _args: string[], opts: any) => {
    const p = new FakeProc(opts.env.CODEX_HOME);
    codex.procs.push(p);
    if (codex.spawnFail) {
      p.pid = undefined;
      setImmediate(() => {
        p.emit('error', new Error('spawn ENOENT'));
        p.emit('close', -2);
      });
    }
    return p;
  },
};
mock.module('node:child_process', { namedExports: fakeCp });
// the Codex helper is started through the proc port (electron/platform/ports/proc.cjs)
createRequire(import.meta.url)('../../electron/platform/ports/proc.cjs').installProc(fakeCp);

export const relayCtl = { start: async () => 'http://127.0.0.1:5555/v1', made: 0, stops: 0, dropped: [] as string[] };
mock.module('../../electron/identity/accounts/relay.cjs', {
  namedExports: {
    Relay: class {
      accounts: any;
      realtimeBase: string | null = null;
      realtimeSidebandBase: string | null = null;
      constructor(accounts: any) {
        this.accounts = accounts;
        relayCtl.made++;
      }
      async start() {
        const base = await relayCtl.start();
        const origin = base.replace(/\/v1$/, '');
        this.realtimeBase = `${origin}/backend-api/codex`;
        this.realtimeSidebandBase = `${origin}/v1/live`;
        return base;
      }
      stop() {
        relayCtl.stops++;
      }
      dropSession(t: string) {
        relayCtl.dropped.push(t);
      }
    },
  },
});

export const { Accounts, readAuth, limitInfo } = createRequire(import.meta.url)('../../electron/identity/codexAccounts.cjs');

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-accounts-cov-'));
export const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

export const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
/** A ChatGPT login in `home` (exp in seconds). */
export function chatgptAuth(home: string, email: string, accountId: string, exp = 4e9, plan = 'plus') {
  fs.mkdirSync(home, { recursive: true });
  const auth = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan } };
  fs.writeFileSync(
    path.join(home, 'auth.json'),
    JSON.stringify({
      tokens: { access_token: jwt({ ...auth, exp, tag: email }), id_token: jwt({ ...auth, email }), account_id: accountId },
    }),
  );
}
export function keyHome(home: string, k: string) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: k }));
}
export const sub = (id: string, extra: object = {}) => ({
  id,
  kind: 'chatgpt',
  email: `${id}@example.com`,
  chatgptAccountId: `acct-${id}`,
  status: 'ok',
  ...extra,
});

const timed = new WeakSet<TestContext>();
let n = 0;
type Reply = { result?: any; error?: any } | undefined;
/**
 * A pool on fresh folders. `defaultAuth`: the CLI's own login ('a@example.com' by default), a key, or none.
 * `homes`: ChatGPT logins (or keys, as 'key:<k>') to write for added accounts. Timers are faked.
 */
export function setup(
  t: TestContext,
  o: {
    state?: any;
    defaultAuth?: 'chatgpt' | 'none' | { key: string };
    homes?: Record<string, string>;
    extra?: object;
    reply?: (m: any) => Reply;
    timers?: boolean;
  } = {},
) {
  if (o.timers !== false && !timed.has(t)) {
    timed.add(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  }
  codex.handle = defaultHandle;
  codex.procs = [];
  codex.spawnFail = false;
  relayCtl.start = async () => 'http://127.0.0.1:5555/v1';
  relayCtl.made = relayCtl.stops = 0;
  relayCtl.dropped = [];
  const id = n++;
  const codexHome = path.join(tmp, `codex-${id}`);
  fs.mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  const da = o.defaultAuth ?? 'chatgpt';
  if (da === 'chatgpt') chatgptAuth(codexHome, 'a@example.com', 'acct-default');
  else if (da !== 'none') keyHome(codexHome, da.key);
  const userData = path.join(tmp, `ud-${id}`);
  fs.mkdirSync(userData, { recursive: true });
  for (const [acc, v] of Object.entries(o.homes ?? {})) {
    const home = path.join(userData, 'accounts', acc);
    if (v.startsWith('key:')) keyHome(home, v.slice(4));
    else chatgptAuth(home, v, `acct-${acc}`);
  }
  if (o.state) fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify(o.state));
  const sent: any[] = [];
  const events: any[] = [];
  const opened: string[] = [];
  const server: any = {
    intercepts: new Set<(m: any) => boolean>(),
    listeners: new Set<(e: any) => void>(),
    reply:
      o.reply ??
      ((m: any): Reply => ({ result: m.method === 'account/rateLimits/read' ? { rateLimits: { primary: { usedPercent: 5 } } } : {} })),
    send(m: any) {
      sent.push(m);
      if (typeof m.id !== 'string' || !m.method) return;
      const r = server.reply(m);
      if (r) setImmediate(() => [...server.intercepts].forEach((h: any) => h({ id: m.id, ...r })));
    },
  };
  const a = new Accounts({
    userData,
    server,
    findBin: () => 'codex',
    clientInfo: { name: 'test' },
    safeStorage: fakeSafe(),
    broadcast: (e: any) => events.push(e),
    openExternal: (u: string) => opened.push(u),
    ...(o.extra ?? {}),
  });
  t.after(() => a.dispose());
  return {
    a,
    sent,
    server,
    events,
    opened,
    userData,
    codexHome,
    notices: () => events.filter((e) => e.type === 'notice').map(({ type, ...rest }) => rest),
    requests: () => sent.filter((m) => m.method).map((m) => m.method),
  };
}
