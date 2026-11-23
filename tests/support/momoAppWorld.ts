// A main process for MoMo's services (electron/app/momo.cjs, tests/momoWiring.test.ts, tests/momoBackground.test.ts): a real
// ChatsStore and tool registry, fake IPC, windows, controller, sessions, notifier and Electron, and MoMo on them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openMomo } = require('../../electron/app/momo.cjs');
const { Registry } = require('../../electron/capabilities/contract/registry.cjs');
const { ChatsStore } = require('../../electron/platform/chats.cjs');

/** safeStorage that "encrypts" by reversing the bytes. */
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8').reverse(),
  decryptString: (b: Buffer) => Buffer.from(b).reverse().toString('utf8'),
};

export function world(
  o: {
    allowed?: boolean;
    deletion?: boolean;
    capabilities?: boolean;
    prefs?: any;
    controller?: boolean;
    patchOk?: boolean;
    seed?: (momoDir: string) => void;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-wire-'));
  // files already in MoMo's folder when it opens (what an older build left)
  if (o.seed) {
    fs.mkdirSync(path.join(root, 'momo'), { recursive: true });
    o.seed(path.join(root, 'momo'));
  }
  const handlers = new Map<string, any>();
  const broadcasts: any[] = [];
  const access: ((on: boolean) => void)[] = [];
  const chats = new ChatsStore(path.join(root, 'threads'), { legacyMirror: false });
  const sends: any[] = [];
  const opened: any[] = [];
  const w: any = {
    root,
    handlers,
    broadcasts,
    access,
    chats,
    sends,
    opened,
    allowed: o.allowed ?? false,
    // no quiet hours unless a test sets them: MoMo's notices would otherwise depend on the time the test runs at
    prefs: { ...(o.prefs ?? {}), momo: { ...(o.prefs?.momo ?? {}), routines: { quietHours: null, ...(o.prefs?.momo?.routines ?? {}) } } },
    deleted: [] as string[],
  };
  const mini = { isDestroyed: () => false, webContents: { id: 7 }, hide: () => opened.push('hide') };
  const own = new Map<string, any>();
  w.live = {
    chats,
    capabilities: o.capabilities === false ? null : new Registry(),
    mini,
    controller:
      o.controller === false
        ? null
        : {
            stopped: [] as string[],
            stopChat: async (id: string) => void w.live.controller.stopped.push(id),
            state: { get: () => ({ turn: 'idle', queue: [] }) },
            sessionGone: async () => false,
            ref: (id: string) => {
              const seg = chats.record(id).segments.at(-1);
              return { kind: seg.kind, id: seg.nativeId };
            },
            send: (chatId: string, item: any, senderId: number, now: boolean) => (
              sends.push({ chatId, item, senderId, now }), { id: item.id, action: 'started' }
            ),
          },
    claudeTurns: { own, setOwn: (id: string, v: any) => own.set(id, v), pickOf: () => null },
    accounts: null,
    identity: {
      instances: (h: string) =>
        h === 'claude'
          ? [
              { account: 'du@work', kind: 'harnessAuth', billing: 'subscription' },
              { account: 'apiKey', kind: 'sageKey', billing: 'apiKey' },
            ]
          : [],
    },
    acpAdmission: {
      list: () => [
        // admitted, but its quirks can't confine it: not one MoMo runs on (#2278)
        { id: 'kimi', state: 'admitted' },
        { id: 'opencode', state: 'admitted' },
        { id: 'goose', state: 'missing' },
      ],
    },
    patchPrefs: (set: any) => (o.patchOk === false ? false : ((w.prefs = { ...w.prefs, ...set }), true)),
    computerUse: { helper: null },
    sessions: { has: (id: string) => w.sessionState.has(id), get: (id: string) => w.sessionState.get(id), patch: () => undefined },
    notifier: {
      quiet: null as any,
      shown: [] as any[],
      noticed: [] as any[],
      notice(n: any) {
        this.noticed.push(n);
      },
      setQuiet(q: any) {
        this.quiet = q;
      },
      notify(kind: string, key: string, opts: any) {
        this.shown.push([kind, key, opts]);
        return {};
      },
      clear: () => undefined,
      clearMatching: () => undefined,
    },
    archived: [] as string[],
    archiveChat: (id: string) => w.live.archived.push(id),
    runLedger: { forget: () => undefined },
    chatDeletion:
      o.deletion === false
        ? undefined
        : {
            onDeleted: () => undefined,
            isDeleted: (id: string) => w.deleted.includes(id),
            delete: async (id: string) => {
              w.deleted.push(id);
              w.live.chatDeletion.onDeleted({ chatId: id });
            },
          },
  };
  w.window = { id: 1 };
  w.openedPaths = [] as string[];
  w.revealed = [] as string[];
  w.electron = {
    safeStorage,
    dialog: {
      showOpenDialog: async () => w.dialog ?? { canceled: true, filePaths: [] },
      showSaveDialog: async () => w.saveDialog ?? { canceled: true },
    },
    shell: {
      openExternal: (url: string) => opened.push(url),
      openPath: async (p: string) => (w.openedPaths.push(p), ''),
      showItemInFolder: (p: string) => w.revealed.push(p),
    },
    BrowserWindow: { fromWebContents: (wc: any) => (wc === 'app' ? w.window : null) },
  };
  w.usable = new Set<string>(['claude']);
  w.sessionState = new Map<string, any>();
  w.ran = [] as any[];
  w.m = openMomo({
    userData: root,
    ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn), removeHandler: (ch: string) => handlers.delete(ch) },
    live: w.live,
    claude: { setIsolated: (fn: any) => (w.claudeIsolated = fn) },
    readState: () => ({ prefs: w.prefs }),
    broadcastAll: (ch: string, payload?: unknown) => broadcasts.push([ch, payload]),
    appWindows: {
      commandMainWindow: async (cmd: string) => void opened.push(cmd),
      readyMainWindow: async () => w.window,
      chatInView: (id: string) => id === w.inView,
    },
    chatStart: {
      prefs: () => w.prefs,
      codexThread: async () => ({ id: 'th1' }),
      claudeSession: () => undefined,
      acpSession: () => undefined,
      chats,
      worktree: async () => ({ ok: false }),
      script: async () => ({ exitCode: 0, output: '' }),
      started: () => undefined,
    },
    usable: async (kind: string) => w.usable.has(kind),
    sendRun: async (_c: any, chatId: string, item: any) => (w.ran.push([chatId, item]), { id: item.id, action: 'started' }),
    electron: w.electron,
    allowed: () => w.allowed,
    onAccess: (cb: (on: boolean) => void) => (access.push(cb), () => undefined),
  });
  w.call = (ch: string, ...args: any[]) => handlers.get(ch)({ sender: 'app' }, ...args);
  w.from = (sender: any, ch: string, ...args: any[]) => handlers.get(ch)({ sender }, ...args);
  return w;
}
