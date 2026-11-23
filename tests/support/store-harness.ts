// Loads the real src/store/store.ts with its boundaries replaced: the preload bridge (window.native)
// is a recording fake, and the harness modules the store drives are mock.module stubs. Every call
// lands in `calls` as [name, args]; `impl[name]` sets what a call returns (default: a resolved
// undefined for native, undefined for the stubs). Vite's import.meta.env.DEV / import.meta.hot are
// supplied the way Vite does, by replacing them at load (see `dev` and `hot` below).
import { deletionVisibility } from '../../src/store/deletionVisibility.ts';
import { mock } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { installRealRuntime } from './ports/runtime.ts';
import { STORE_SLICES } from './stubs.ts';
import { installNativeStub } from './ports/native.ts';
import { resolvedEnvironment } from './environment.ts';

export { resolvedEnvironment };

export const calls: [string, any[]][] = [];
export const impl: Record<string, (...args: any[]) => any> = {};
/** Callbacks the store registered with native `on*` subscriptions, by name (e.g. 'codex.onItem'). */
export const listeners: Record<string, (...args: any[]) => any> = {};

export const callsOf = (name: string) => calls.filter(([n]) => n === name).map(([, a]) => a);
export const reset = () => {
  calls.length = 0;
  for (const k of Object.keys(impl)) delete impl[k];
};

function record(name: string, args: any[], fallback: () => any) {
  calls.push([name, args]);
  const f = impl[name];
  return f ? f(...args) : fallback();
}

/** A bridge object whose every path is a function recording its calls. */
function bridge(path: string): any {
  const cache = new Map<string | symbol, any>();
  const fn = (...args: any[]) => {
    if (/(^|\.)on[A-Z]\w*$/.test(path) && typeof args[0] === 'function') {
      listeners[path] = args[0];
      return record(path, args, () => () => {});
    }
    return record(path, args, () =>
      Promise.resolve(
        path === 'chats.delete'
          ? deleteReceipt(args[0])
          : path === 'chats.deletions'
            ? []
            : path === 'orchestration.snapshot'
              ? { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} }
              : path === 'env.resolve'
                ? resolvedEnvironment()
                : undefined,
      ),
    );
  };
  return new Proxy(fn, {
    get(_t, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (path === '' && key === 'platform') return 'darwin';
      if (!cache.has(key)) cache.set(key, bridge(path ? `${path}.${String(key)}` : String(key)));
      return cache.get(key);
    },
  });
}
/** Recording stubs answering undefined; the `async` ones answer a resolved promise, as the real ones do. */
const stub = (prefix: string, names: string[], async: string[] = []) =>
  Object.fromEntries(
    [...names, ...async].map((n) => [
      n,
      (...args: any[]) => record(`${prefix}.${n}`, args, () => (async.includes(n) ? Promise.resolve(undefined) : undefined)),
    ]),
  );
/** An object whose every property is a recording stub (codexApi, chatProxy). */
const stubObject = (prefix: string) =>
  new Proxy(
    {},
    {
      get: (_t, key) =>
        typeof key === 'symbol' || key === 'then'
          ? undefined
          : (...args: any[]) => record(`${prefix}.${String(key)}`, args, () => Promise.resolve(undefined)),
    },
  );

export const deleteReceipt = (id: string, nativeKeys = [id]) => ({ chatId: id, nativeKeys, nativeDeleted: true, metadata: 'retained' });
export const native = bridge('');
export const location = { hash: '', reload: () => void calls.push(['location.reload', []]) };
const win: any = new EventTarget();
win.native = native;
// the port the store reads (src/lib/native.ts), as src/lib/nativeInstall.ts installs window.native
installNativeStub(native);
(globalThis as any).window = win;
(globalThis as any).location = location;
impl['flags.isEnabled'] = () => true;
const defaults = { ...impl };
/** Explicitly start a fresh app lifetime in a fixture; ordinary call-log cleanup retains terminal receipts. */
export const resetDeletionLifetime = () => {
  (deletionVisibility as any).deleted.clear();
  (deletionVisibility as any).revision = 0;
};
/** Clear the call log and every configured result (flags stay on). */
export const resetAll = () => {
  reset();
  Object.assign(impl, defaults);
};

// the dev hooks read import.meta.env.DEV and import.meta.hot, which only Vite defines: set per test file here
const DEV_HOOKS = new URL('../../src/store/devHooks.ts', import.meta.url).href;
registerHooks({
  load(url, context, next) {
    // a mocked .tsx keeps its stand-in source but needs the plain URL past register.ts
    if (url.startsWith('file:') && /\.tsx\?node-test-mock=/.test(url)) return next(url.split('?')[0], context);
    if (url !== DEV_HOOKS) return next(url, context);
    const file = fileURLToPath(url);
    const out = transformSync(file, readFileSync(file, 'utf8'), {
      sourcemap: true,
      define: { 'import.meta.env.DEV': 'globalThis.__storeDev', 'import.meta.hot': 'globalThis.__storeHot' },
    });
    const map = Buffer.from(JSON.stringify(out.map)).toString('base64');
    return { format: 'module', shortCircuit: true, source: `${out.code}\n//# sourceMappingURL=data:application/json;base64,${map}\n` };
  },
});

const m = (rel: string, namedExports: Record<string, unknown>) =>
  mock.module(new URL(`../../src/${rel}`, import.meta.url).href, { namedExports });

m(
  'session/harness/claude.ts',
  stub(
    'claude',
    [
      'archivedClaudeThreads',
      'archivedCodexMissing',
      'loadArchivedClaudeInfo',
      'claudeStop',
      'claudeEditMessage',
      'claudeStopTask',
      'claudeStopAllTasks',
      'stopClaudeTask',
      'claudeMoveToBackground',
      'setClaudeUltracode',
      'loadClaudeThreads',
      'searchClaudeThreads',
      'openClaudeThread',
      'openClaudeSideChat',
      'rememberClaudeThread',
      'loadClaudeTurns',
      'markNewClaudeSession',
      'startClaude',
      'startClaudeThread',
    ],
    ['resolveClaudeRequest'],
  ),
);
m(
  'session/harness/acp.ts',
  stub(
    'acp',
    [
      'acpInterrupt',
      'acpLabelOf',
      'acpRename',
      'loadOlderAcpTurns',
      'archivedAcpThreads',
      'loadAcpThreads',
      'searchAcpThreads',
      'openAcpThread',
      'startAcp',
      'startAcpThread',
      'basicLabel',
    ],
    ['resolveAcpRequest'],
  ),
);
m('session/harness/acpHost.ts', stub('acp', ['startHostAcpThread']));
m('session/harness/switch.ts', stub('switch', ['openCompositeThread'], ['newChatWithSummary']));
m('session/harness/claude/history.ts', stub('claudeHistory', ['readClaudeTurns', 'openLatestClaudeTurns'], ['loadOlderClaudeTurns']));
m('harness/adapters/codex.ts', stub('codex', ['codexIsIdle', 'codexRequest', 'codexLeftIdle', 'onCodexNotification'], ['respondToCodex']));
m('harness/adapters/codexApi.ts', { codexApi: stubObject('api') });
m('harness/adapters/proxy.ts', { chatProxy: stubObject('proxy') });
m('session/harness/adapters/codexSemantics.ts', { ...stub('sem', ['pauseCodexGoal']), CODEX_HANDLERS: {} });
m('store/session/runSemantic.ts', stub('run', ['runSemantic', 'refusalText', 'fillTemplate']));
m('lib/telemetry.ts', stub('telemetry', ['shareTurn', 'countTurn', 'track', 'reportError', 'turnPayload', 'installErrorHandlers']));
m('lib/codexImportSource.ts', { importSource: (it: any) => ({ id: it.source }) });

/** Load the store with DEV and HMR as given (each test file is its own process, so once per file). */
export async function loadStore(opts: { dev?: boolean; hot?: { accept(cb: () => void): void } } = {}) {
  (globalThis as any).__storeDev = !!opts.dev;
  (globalThis as any).__storeHot = opts.hot;
  // the store's slices as one object, as the tests call them (getState and setState being core's get and set), with the
  // other layers' names the store used to re-export
  const modules = await Promise.all(STORE_SLICES.map((rel) => import(`../../src/${rel}`)));
  const { selectionAttachment } = await import('../../src/lib/annotations.ts');
  const { withChatNotes } = await import('../../src/lib/chatMeta.ts');
  const { turnFromServer } = await import('../../shared/codexTurns.mjs');
  const { provisionalTitle } = await import('../../shared/title.mjs');
  const store: any = Object.assign({}, ...modules, { selectionAttachment, withChatNotes, turnFromServer, provisionalTitle });
  store.getState = store.get;
  store.setState = store.set;
  // as src/main.tsx does: the dev-only window hooks, which install only under DEV
  await import('../../src/store/devHooks.ts');
  // the store reaches the harness modules through the runtime main installs: built from the stubs above
  await installRealRuntime();
  const initial = store.useStore.getState();
  const sessions = await import('../../src/store/session/useSession.ts');
  return {
    store,
    sessions,
    /** Back to the store's first state (module-level memory such as leases stays). */
    resetState: () => {
      store.useStore.setState(initial, true);
      sessions.useSessions.setState({ sessions: {}, loaded: {} }, true);
    },
  };
}

/** Let pending promise callbacks run. */
export const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

/** What main answers while the store boots and connects Codex, before a test overrides it. */
export function bootImpls(over: Record<string, (...args: any[]) => any> = {}) {
  Object.assign(impl, {
    'state.read': async () => ({}),
    'chats.snapshot': async () => ({ chats: {}, newer: [] }),
    'chats.deletions': async () => [],
    'app.info': async () => ({ home: '/home/me', dark: false, codexHome: '/home/me/.codex' }),
    'chats.migration': async () => [],
    'win.isFocused': async () => true,
    'projects.list': async () => ({ projects: [] }),
    'session.withApprovals': async () => [],
    'codex.leases': async () => [],
    'codex.used': async () => false,
    'projects.importCodexBackground': async () => null,
    'codex.start': async () => ({ bin: '/bin/codex' }),
    'codex.connect': async () => ({ codexHome: '/home/me/.codex', userAgent: 'ua' }),
    'accounts.apply': async () => ({ active: null, autoSwitch: true, pool: 'spread', relay: false, login: null, accounts: [] }),
    'codex.negotiated': async () => ({ cliVersion: '1', versionStatus: 'ok', probes: {}, flags: {} }),
    'projects.importCodex': async () => ({ projects: [] }),
    'cloud.list': async () => ({ tasks: [] }),
    'api.accountRead': async () => ({ account: { email: 'a@b' }, requiresOpenaiAuth: false }),
    'api.accountRateLimits': async () => ({ rateLimits: {} }),
    'api.modelList': async () => ({ data: [] }),
    'api.configRead': async () => ({ config: {} }),
    'api.threadList': async () => ({ data: [], nextCursor: null }),
    'api.projectList': async () => ({ data: [] }),
    ...over,
  });
}
