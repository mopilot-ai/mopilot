// Shared SearchPalette UI boundary fakes, rendering probes and query controls.
import { mock } from 'node:test';
import './dom.ts';
import { createElement, act, Profiler } from 'react';
import { fakeStore, render, flush } from './shell-chrome-kit.ts';
import { installNativeStub } from './ports/native.ts';
import { stubStore } from './stubs.ts';

export const thread = (id: string, title: string, extra: any = {}) => ({ id, title, updatedAt: 1, ...extra });
export const THREADS: Record<string, any> = {
  a: thread('a', 'Alpha fix', { projectId: 'p1' }),
  b: thread('b', 'Beta work'),
  e: thread('e', 'Ephemeral', { ephemeral: true }),
  s: thread('s', 'Sub agent', { parentThreadId: 'a' }),
};
const initial = () => ({
  prefs: { keybindings: {} },
  searchOpen: false,
  searchMode: 'all',
  threads: { ...THREADS },
  threadOrder: ['a', 'missing', 'e', 's', 'b'],
  savedProjects: [{ id: 'p1', name: 'Proj One' }],
  claudeArchived: {},
  route: null as any,
});
const defaults = () => ({
  remote: { codex: [], claude: [], sage: [] } as any,
  searchFails: false,
  held: {} as Record<string, Promise<void>>,
  byQuery: {} as Record<string, any>,
  fileHits: { files: [] } as any,
  filesFail: false,
  filesHeld: null as Promise<void> | null,
  folder: null as string | null,
  created: null as string | null,
});

// The general UI suite reads file hits on resolution; ownership tests snapshot each request.
export async function searchPaletteKit({ dynamicCwd = true, captureFileHits = true } = {}) {
  const kit = defaults();
  const store = fakeStore<any>(initial());
  const calls: any[] = [];
  stubStore({
    useStore: store.useStore,
    setState: store.setState,
    navigate: (route: any) => store.setState({ route }),
    threadTitle: (t: any) => t.title,
    projectForThread: (t: any, projects: any[]) => projects.find((p) => p.id === t.projectId),
    createProject: async (p: string) => (calls.push(['create', p]), kit.created),
    currentCwdForNewChat: () => (dynamicCwd ? store.getState().newChatCwd || '/cwd' : '/cwd'),
    searchThreads: async (q: string) => {
      calls.push(['searchThreads', q]);
      await kit.held[q];
      if (kit.searchFails) throw new Error('offline');
      return kit.byQuery[q] ?? kit.remote;
    },
    clearNewChatProject: (reuseRunOn: boolean) => calls.push(['clearProject', reuseRunOn]),
  });
  installNativeStub({
    search: {
      files: async (cwd: string, q: string, opts: any) => {
        calls.push(['files', cwd, q, opts]);
        const fail = kit.filesFail;
        const hits = kit.fileHits;
        await kit.filesHeld;
        if (fail) throw new Error('no index');
        return captureFileHits ? hits : kit.fileHits;
      },
    },
    dialog: { openFolder: async () => (calls.push(['openFolder']), kit.folder) },
  });
  mock.module('../../src/session/open.ts', { namedExports: { openFile: (p: string) => calls.push(['openFile', p]) } });
  mock.module('../../src/components/pages/Settings.tsx', {
    namedExports: {
      SECTIONS: [
        { id: 'general', label: 'General', icon: null },
        { id: 'plugins', label: 'Plugins', icon: null },
        { id: 'docs', label: 'Documentation', icon: null, external: true },
      ],
    },
  });
  const { SearchPalette } = await import('../../src/components/search/SearchPalette.tsx');

  const reset = () => {
    store.reset(initial());
    calls.length = 0;
    Object.assign(kit, defaults());
  };
  const open = (mode = 'all') => act(async () => store.setState({ searchOpen: true, searchMode: mode }));
  const debounce = async () => {
    await act(async () => new Promise((r) => setTimeout(r, 150)));
    await flush();
  };
  const input = (host: Element) => host.querySelector('.palette-input') as HTMLInputElement;
  const items = (host: Element) => [...host.querySelectorAll('.palette-item')].map((e) => e.querySelector('.palette-title')!.textContent);
  const alert = (host: Element) => host.querySelector('[role="alert"]')?.textContent;
  const item = (host: Element, title: string) =>
    [...host.querySelectorAll('.palette-item')].find((e) => e.querySelector('.palette-title')!.textContent === title) as HTMLElement;

  async function mount() {
    // what each commit shows (opening or switching modes must not commit a frame with the last search)
    const frames: string[][] = [];
    const shown = () => {
      const field = document.querySelector<HTMLInputElement>('.palette-input');
      if (field) frames.push([field.placeholder, field.value]);
    };
    const r = await render(createElement(Profiler, { id: 'palette', onRender: shown }, createElement(SearchPalette)));
    // every highlight change scrolls the chosen row into view
    const scrolled: string[] = [];
    (globalThis as any).window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.querySelector('.palette-title')!.textContent!);
    };
    return { ...r, scrolled, frames };
  }
  const sections = (host: Element) => [...host.querySelectorAll('.palette-section')].map((e) => e.textContent);
  const selected = (host: Element) => host.querySelector('.palette-item.sel .palette-title')?.textContent;
  return Object.assign(kit, { SearchPalette, store, calls, reset, open, debounce, input, items, item, alert, mount, sections, selected });
}
