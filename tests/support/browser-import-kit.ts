// The browser-import tests' shared bridge, progress subscriptions and preference store.
import { fakeStore, mockSource, stubStore } from './stubs.ts';
import { installNativeStub } from './ports/native.ts';

export function browserImportKit({ passwordFiles = false } = {}) {
  const f: any = {
    calls: [] as any[][],
    handlers: {} as Record<string, (...a: any[]) => any>,
    progress: new Set<(e: any) => void>(),
    flags: { 'shared.browser.import': true },
  };
  const call =
    (name: string) =>
    (...a: any[]) => (f.calls.push([name, ...a]), f.handlers[name](...a));
  /** Every call answers something; a test replaces the ones it cares about. */
  const defaults = () => ({
    sources: async () => [],
    start: async () => ({ ok: false, code: 'unsupported', message: '' }),
    run: async () => ({ ok: true, results: {} }),
    cancel: async () => true,
    imported: async () => ({ history: [], bookmarks: [], cookies: [], passwords: [], last: null }),
    removeCookies: async () => 0,
    deleteHistory: async () => 0,
    deleteBookmarks: async () => 0,
    deletePasswords: async () => 0,
    openFullDiskAccess: async () => undefined,
    ...(passwordFiles
      ? { choosePasswordFile: async () => ({ name: 'Passwords.csv' }), trashPasswordFile: async () => ({ ok: true }) }
      : {}),
  });
  f.handlers = defaults();
  installNativeStub({
    browser: {
      import: {
        ...Object.fromEntries(Object.keys(defaults()).map((name) => [name, call(name)])),
        onProgress: (cb: (e: any) => void) => (f.progress.add(cb), () => f.progress.delete(cb)),
      },
    },
  });
  mockSource('src/lib/flags.ts', { isEnabled: (k: string) => !!f.flags[k] });
  const store = fakeStore({ prefs: { browserImportPrompt: 'pending', browserImportSnoozes: 0, browserImportSnoozeUntil: 0 } as any });
  stubStore({
    useStore: store.useStore,
    setPrefs: (p: any) => (f.calls.push(['setPrefs', p]), store.set({ prefs: { ...store.get().prefs, ...p } })),
    toast: (...a: unknown[]) => f.calls.push(['toast', ...a]),
  });
  return { f, defaults, store };
}
