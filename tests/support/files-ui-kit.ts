// The Files pane's UI test setup (tests/filesWorkspaceUI.test.ts, tests/fileEditorUI.test.ts): a folder's tree and files
// on a fake disk, content search and writes answered as `fx` says, the highlighter, menus and confirm stubbed, the pane's
// width as ResizeObserver reports it, and helpers to open, type and press keys.
import { mock, beforeEach } from 'node:test';
import './dom.ts';
import { markdownStub, one, settle, render } from './shell-panels-kit.ts';
import { popoverStubs } from './stubs.ts';
import { installNativeStub } from './ports/native.ts';

export const theme = { dark: false };
export const calls: unknown[][] = [];
export const tree: Record<string, { fileName: string; isDirectory: boolean }[]> = {};
export const disk: Record<string, string> = {};
/** What the next content search answers, whether writes succeed, the confirm's answer and the pane's width. */
export const fx = {
  textSearch: (async () => ({ matches: [], truncated: false })) as (cwd: string, q: string) => Promise<any>,
  writeResult: { ok: true } as { ok: boolean; error?: string },
  confirmAnswer: true,
  paneWidth: 900,
  /** while set, file reads wait for it */
  readGate: null as Promise<void> | null,
};
const native = {
  fs: {
    readDir: async (p: string) => tree[p] ?? [],
    readText: async (p: string) => {
      calls.push(['readText', p]);
      if (fx.readGate) await fx.readGate;
      if (disk[p] === 'throw') throw new Error('EIO');
      return disk[p] ?? null;
    },
    writeText: async (p: string, text: string) => {
      calls.push(['writeText', p, text]);
      if (fx.writeResult.ok) disk[p] = text;
      return fx.writeResult;
    },
  },
  search: {
    files: async () => ({ files: [] }),
    text: (cwd: string, q: string, opts: unknown) => {
      calls.push(['text', cwd, q, opts]);
      return fx.textSearch(cwd, q);
    },
  },
};
installNativeStub(native);
const highlight = async (code: string) =>
  code
    .split('\n')
    .map((l) => `<span class="line" data-colored="1">${l}</span>`)
    .join('\n');
mock.module('../../src/lib/highlight.ts', {
  namedExports: { highlight, langFromPath: (p: string) => (p.endsWith('.md') ? 'markdown' : p.endsWith('.ts') ? 'typescript' : 'text') },
});
mock.module('../../src/session/open.ts', {
  namedExports: { openPath: (p: string) => calls.push(['openPath', p]), revealPath: (p: string) => calls.push(['revealPath', p]) },
});
mock.module('../../src/session/clipboard.ts', { namedExports: { copyText: (t: string) => calls.push(['copyText', t]) } });
mock.module('../../src/components/ui/Popover.tsx', { namedExports: popoverStubs() });
mock.module('../../src/components/markdown/Markdown.tsx', { namedExports: markdownStub(theme) });
export const { createElement, act } = await import('react');
mock.module('../../src/components/panels/DiffPanel.tsx', {
  namedExports: { LangIcon: ({ path }: { path: string }) => createElement('i', { 'data-icon': path }) },
});
export const { FilesPanel, FILES_SIDE_BY_SIDE_PX } = await import('../../src/components/panels/FilesPanel.tsx');
export const { FilePreview } = await import('../../src/components/panels/files/FilePreview.tsx');
export const { lineOffset, indentUnit, RECOLOR_MS } = await import('../../src/components/panels/files/FileCode.tsx');
export const { filterQuery, groupMatches } = await import('../../src/components/panels/files/FileTree.tsx');
export const { resetFilesWorkspaces, openWorkspaceFile, filesWorkspace } = await import('../../src/lib/filesWorkspace.ts');
export const { resetFileDrafts, setFileDraft, hasDraft } = await import('../../src/lib/fileDrafts.ts');
export const { get: getState, set: setState } = await import('../../src/store/core.ts');

export const scrolled: string[] = [];
(window as any).HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
  scrolled.push(this.textContent ?? '');
};
export const asked: string[] = [];
(window as any).confirm = (m: string) => (asked.push(m), fx.confirmAnswer);
export const inserted: string[] = [];
(document as any).execCommand = (cmd: string, _ui: boolean, value: string) => (inserted.push(`${cmd}:${value}`), true);
// the pane's width as its ResizeObserver reads it (fx.paneWidth: the test DOM has no layout)
(globalThis as any).ResizeObserver = class {
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(el: HTMLElement) {
    el.getBoundingClientRect = () => ({ width: fx.paneWidth }) as DOMRect;
    this.cb();
  }
  disconnect() {}
};

beforeEach(() => {
  localStorage.clear();
  resetFilesWorkspaces();
  resetFileDrafts();
  calls.length = 0;
  scrolled.length = 0;
  asked.length = 0;
  inserted.length = 0;
  fx.confirmAnswer = true;
  fx.readGate = null;
  fx.paneWidth = 900;
  fx.writeResult = { ok: true };
  fx.textSearch = async () => ({ matches: [], truncated: false });
  setState((s: any) => ({ prefs: { ...s.prefs, filesWrap: false, filesTreeSide: 'left' }, toasts: [] }));
  for (const k of Object.keys(tree)) delete tree[k];
  for (const k of Object.keys(disk)) delete disk[k];
  tree['/repo'] = [
    { fileName: 'src', isDirectory: true },
    { fileName: 'a.ts', isDirectory: false },
    { fileName: 'b.ts', isDirectory: false },
  ];
  tree['/repo/src'] = [{ fileName: 'deep.ts', isDirectory: false }];
  disk['/repo/a.ts'] = 'one\ntwo\nthree';
  disk['/repo/b.ts'] = 'bee';
  disk['/repo/src/deep.ts'] = 'deep';
});

export const tabs = (host: HTMLElement) =>
  [...host.querySelectorAll('.files-tab')].map(
    (t) => `${t.querySelector('.files-tab-name > span:not(.files-tab-dirty)')!.textContent}${t.classList.contains('active') ? '*' : ''}`,
  );
export const click = async (el: Element) => act(async () => (el as HTMLElement).click());
export const key = (el: Element, init: Record<string, unknown>) =>
  act(async () => void el.dispatchEvent(new (window as any).KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
export async function type(area: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(area), 'value')!.set!;
    setter.call(area, value);
    area.dispatchEvent(new (window as any).Event('input', { bubbles: true }));
  });
}
export async function panel() {
  const r = await render(createElement(FilesPanel, { cwd: '/repo' }));
  await settle(act);
  return r;
}
export async function openFile(r: { host: HTMLElement }, name: string) {
  await click(one(r.host, '.files-tree .file-node', name));
  await settle(act);
}
export async function preview(path = '/repo/a.ts', extra: Record<string, unknown> = {}) {
  const r = await render(createElement(FilePreview, { path, cwd: '/repo', ...extra }));
  await settle(act);
  return r;
}
