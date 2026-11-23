// Duplicate lifecycle: a fresh same-chat pane, an in-memory history token and rollback limited to that copy.
import { noteIgnored } from './ignored';
import type { PaneTab, AppState } from '../../shared/model/window';

type Snapshot = Pick<AppState, 'paneTabs' | 'paneActive' | 'diffPanel'>;
type CopyApi = {
  bindPane(paneId: string, pageId: number, chat: string | null): Promise<boolean>;
  captureHistory(paneId: string, targetPaneId: string): Promise<{ token: string; url: string; title: string; chat: string | null }>;
  restoreHistory(token: string, paneId: string): Promise<boolean>;
  discardHistory(token: string): Promise<boolean>;
};
type Page = { id: number; partition: string; chat: string | null; ready: Promise<boolean> };
type Run = {
  source: Page;
  targetId: string;
  cancelled: boolean;
  token?: string;
  resolve: (page: Page) => void;
  abort: () => void;
  promise: Promise<void>;
};
const failed = () => new Error('Could not duplicate this tab. Try again.');

export class BrowserDuplication {
  private pages = new Map<string, Page>();
  private runs = new Map<string, Run>();
  private deps: {
    get: () => Snapshot;
    set: (fn: (state: Snapshot) => Partial<Snapshot>) => void;
    api: CopyApi;
    chatOf: (id: string) => string;
    /** Whether the window's view now shows a tab: a copy of another chat's tab mounts behind (default: shown). */
    shows?: (tab: PaneTab) => boolean;
    timeoutMs?: number;
  };
  constructor(deps: BrowserDuplication['deps']) {
    this.deps = deps;
  }

  /** The page, not just its numeric Electron id, owns the registration until its panel effect retires. */
  bind(paneId: string, id: number, partition: string, chat: string | null) {
    let page = this.pages.get(paneId);
    if (!page || page.id !== id || page.chat !== chat) {
      for (const run of this.runs.values()) if (page && (run.source === page || run.targetId === paneId)) run.abort();
      page = { id, partition, chat, ready: this.deps.api.bindPane(paneId, id, chat) };
      // A failed binding reaches Duplicate when it is requested; ordinary browsing remains usable.
      page.ready.catch((error) => noteIgnored('bind a pane for Duplicate', error));
      this.pages.set(paneId, page);
      this.patch(paneId, { duplicating: false, duplicateError: undefined });
      for (const run of this.runs.values()) if (run.targetId === paneId) run.resolve(page);
    }
    const owned = page;
    return () => {
      if (this.pages.get(paneId) !== owned) return;
      this.pages.delete(paneId);
      this.patch(paneId, { duplicating: false });
      for (const run of this.runs.values())
        if (run.source === owned || run.targetId === paneId) {
          run.abort();
        }
    };
  }

  duplicate(paneId: string): Promise<void> {
    const pending = this.runs.get(paneId);
    if (pending) return pending.promise;
    const source = this.deps.get().paneTabs.find((tab) => tab.id === paneId && tab.kind === 'browser');
    if (!source) return Promise.resolve();
    const owner = source.agentChat ?? source.ownerChat;
    const chat = owner ? this.deps.chatOf(owner) : null;
    const id = `browser-${crypto.randomUUID()}`;
    const copy: PaneTab = {
      id,
      kind: 'browser',
      url: source.url,
      title: source.title,
      ...(chat ? { ownerChat: chat } : {}),
      ...(source.agentChat ? { agentChat: chat!, agentTab: `tab_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}` } : {}),
    };
    const add = () =>
      this.deps.set((state) => {
        const index = state.paneTabs.findIndex((tab) => tab.id === paneId);
        if (index < 0) throw failed();
        const paneTabs = [...state.paneTabs.slice(0, index + 1), copy, ...state.paneTabs.slice(index + 1)];
        // the user may have moved to another chat while the history copied: its pane stays as it is
        if (this.deps.shows && !this.deps.shows(copy)) return { paneTabs };
        return { paneTabs, paneActive: id, diffPanel: { ...state.diffPanel, open: true } };
      });
    if (!source.url) {
      add();
      return Promise.resolve();
    }
    const page = this.pages.get(paneId);
    if (!page || page.chat !== chat) {
      this.patch(paneId, { duplicateError: failed().message });
      return Promise.resolve();
    }
    let resolve!: Run['resolve'];
    const ready = new Promise<Page>((yes) => {
      resolve = yes;
    });
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_yes, no) => {
      rejectAbort = no;
    });
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, aborted]);
    const run: Run = {
      source: page,
      targetId: id,
      cancelled: false,
      resolve,
      abort: () => {
        run.cancelled = true;
        rejectAbort(failed());
      },
      promise: Promise.resolve(),
    };
    this.runs.set(paneId, run);
    this.patch(paneId, { duplicating: true, duplicateError: undefined });
    const check = () => {
      const current = this.deps.get().paneTabs.find((tab) => tab.id === paneId);
      const owner = current?.agentChat ?? current?.ownerChat;
      if (run.cancelled || this.pages.get(paneId) !== page || !current || (owner ? this.deps.chatOf(owner) : null) !== chat) throw failed();
    };
    const timer = setTimeout(run.abort, this.deps.timeoutMs ?? 30_000);
    run.promise = (async () => {
      try {
        if (!(await wait(page.ready))) throw failed();
        check();
        const snapshot = await wait(
          this.deps.api.captureHistory(paneId, id).then((snapshot) => {
            if (run.cancelled)
              void this.deps.api
                .discardHistory(snapshot.token)
                .catch((error) => noteIgnored('discard a retired browser history copy', error));
            return snapshot;
          }),
        );
        run.token = snapshot.token;
        check();
        if (snapshot.chat !== chat) throw failed();
        Object.assign(copy, {
          url: snapshot.url,
          title: snapshot.title,
          restoring: true,
          browserView: true,
          browserPartition: page.partition,
        });
        add();
        const target = await wait(ready);
        if (!(await wait(target.ready))) throw failed();
        check();
        if (!(await wait(this.deps.api.restoreHistory(snapshot.token, id)))) throw failed();
        check();
        this.patch(id, { restoring: false });
      } catch {
        this.deps.set((state) => {
          const tabs = state.paneTabs.filter((tab) => tab.id !== id);
          return {
            paneTabs: tabs,
            ...(state.paneActive === id ? { paneActive: tabs.some((tab) => tab.id === paneId) ? paneId : (tabs.at(-1)?.id ?? '') } : {}),
            ...(!tabs.length ? { diffPanel: { open: false } } : {}),
          };
        });
        if (this.pages.get(paneId) === page) this.patch(paneId, { duplicateError: failed().message });
      } finally {
        clearTimeout(timer);
        if (run.token)
          void this.deps.api.discardHistory(run.token).catch((error) => noteIgnored('discard a retired browser history copy', error));
        this.runs.delete(paneId);
        if (this.pages.get(paneId) === page) this.patch(paneId, { duplicating: false });
      }
    })();
    return run.promise;
  }

  /** Puts a failed Duplicate's notice away (its close button); the tab stays as it is. */
  dismissError(paneId: string) {
    this.patch(paneId, { duplicateError: undefined });
  }

  private patch(paneId: string, patch: Partial<PaneTab>) {
    this.deps.set((state) => ({ paneTabs: state.paneTabs.map((tab) => (tab.id === paneId ? { ...tab, ...patch } : tab)) }));
  }
}
