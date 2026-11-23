// Shared DOM, git, store and confirmation fixture for diff-panel UI unit cases.
import { mock, beforeEach } from 'node:test';
import { createRequire } from 'node:module';
import '../dom.ts';
import { fakeStore, popoverStub, one, byText, settle, render, typeInto } from '../shell-panels-kit.ts';
import { parseUnifiedDiff } from '../../../src/lib/diff.ts';
import { installNativeStub } from '../ports/native.ts';
import { stubStore } from '../stubs.ts';

const { commitFiles: commitInMain } = createRequire(import.meta.url)('../../../electron/platform/commitFiles.cjs');
const store = fakeStore({ diffPanel: {}, runtime: {}, prefs: {}, drafts: {} });
const calls: unknown[][] = [];
const freshReads: boolean[] = [];
const gitRoots: string[] = [];
const BASE_SHA = 'a'.repeat(40);
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const fail = (stderr: string) => ({ ok: false, stdout: '', stderr });
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  'diff --git a/new.py b/new.py',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.py',
  '@@ -0,0 +1 @@',
  '+print(1)',
  'diff --git a/gone.md b/gone.md',
  'deleted file mode 100644',
  '--- a/gone.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
].join('\n');
const git: { diff: (cwd: string) => Promise<string>; run: (args: string[]) => any } = { diff: async () => DIFF, run: () => ok() };
const native = {
  git: {
    info: async (cwd: string): Promise<any> => ({ root: cwd }),
    status: async () => ({ files: [] }),
    diff: (cwd: string, _file?: string, fresh?: boolean) => (freshReads.push(fresh === true), calls.push(['diff', cwd]), git.diff(cwd)),
    run: async (cwd: string, args: string[]) => {
      const command = args[0] === '--no-lazy-fetch' ? args.slice(1) : args;
      gitRoots.push(cwd);
      calls.push(['git', ...command]);
      return git.run(command);
    },
    // main's commit (electron/platform/commitFiles.cjs) over this fake git: no merge is under way here
    commitFiles: (root: string, message: string, files: unknown) =>
      commitInMain(root, message, files, {
        git: async (args: string[], cwd: string) =>
          args[0] === 'rev-parse' && /^(MERGE|CHERRY_PICK|REVERT)_HEAD$/.test(args.at(-1) ?? '') ? fail('') : native.git.run(cwd, args),
      }),
  },
  clipboard: {
    write: async (t: string) => {
      calls.push(['copy', t]);
    },
  },
};
const { createElement: h, act } = await import('react');
const noteNodes = (notes: any[]) => notes.map((n) => h('div', { key: n.key, 'data-note-line': n.line, 'data-note-side': n.side }, n.node));
// commenting on a diff: a button that adds a comment on its line 2 (the real picker is in tests/diffCommentsUI.test.ts)
const commentRange = (commenting: any) => ({
  path: commenting.path,
  workspace: commenting.workspace,
  startSide: 'R',
  startLine: 2,
  endSide: 'R',
  endLine: 2,
  hunk: '+new',
});
const commentButton = (commenting: any) =>
  commenting && [
    h('button', {
      key: 'add',
      'data-comment': commenting.path,
      'data-workspace': commenting.workspace,
      onClick: () => commenting.onAdd(commentRange(commenting), 'rename'),
    }),
    // posting to GitHub, where the pane offers it (tests/changesReviewThreadsUI.test.ts)
    commenting.onPost &&
      h('button', {
        key: 'post',
        'data-post': commenting.path,
        onClick: async () => calls.push(['posted', await commenting.onPost(commentRange(commenting), 'on github')]),
      }),
  ];
stubStore(store.exports);
installNativeStub(native);
mock.module('../../../src/session/open.ts', {
  namedExports: {
    openPath: (p: string) => calls.push(['openPath', p]),
    openInApp: (app: string, p: string) => calls.push(['openIn', app, p]),
    revealPath: (p: string) => calls.push(['reveal', p]),
    openUrl: (u: string) => calls.push(['openUrl', u]),
  },
});
mock.module('../../../src/components/ui/Popover.tsx', { namedExports: popoverStub });
mock.module('../../../src/lib/highlight.ts', {
  namedExports: {
    langFromPath: (p: string) => (({ ts: 'typescript', py: 'python', md: 'markdown' }) as any)[p.split('.').pop()!] ?? 'text',
  },
});
mock.module('../../../src/components/diff/DiffView.tsx', {
  namedExports: {
    parseUnifiedDiff,
    // the notes (review findings) render inside, each marked with the line it goes under
    InlineDiff: ({ file, cwd, bare, notes = [], commenting }: any) =>
      h('div', { 'data-inline': file.path, 'data-cwd': cwd, 'data-bare': String(bare) }, noteNodes(notes), commentButton(commenting)),
    SplitDiff: ({ file, notes = [], commenting }: any) =>
      h('div', { 'data-split': file.path }, noteNodes(notes), commentButton(commenting)),
  },
});
const { DiffPanel, LangIcon } = await import('../../../src/components/panels/DiffPanel.tsx');

(globalThis as any).CSS = (window as any).CSS;
let confirmAnswer = true;
const confirms: string[] = [];
(globalThis as any).confirm = (m: string) => (confirms.push(m), confirmAnswer);
const scrolled: string[] = [];
(window as any).HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
  scrolled.push(this.getAttribute('data-path') ?? `finding ${this.getAttribute('data-finding')}`);
};

beforeEach(() => {
  calls.length = 0;
  freshReads.length = 0;
  gitRoots.length = 0;
  store.calls.length = 0;
  confirms.length = 0;
  scrolled.length = 0;
  confirmAnswer = true;
  native.git.info = async (cwd) => ({ root: cwd });
  git.diff = async () => DIFF;
  git.run = (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok('/repo\n');
    if (args[0] === 'ls-files' && args.at(-1) === ':(literal)new.py') return { ...fail('not tracked'), code: 1 };
    return args[0] === 'merge-base' ? ok(BASE_SHA) : args[0] === 'diff' ? ok(args.includes('--cached') ? '' : DIFF) : ok();
  };
});
async function mount(diffPanel: any, threadId: string | null = 't1', runtime: any = {}, prefs: any = {}, cwd = '/repo') {
  store.set({ diffPanel, runtime, prefs: { openDestination: 'finder', ...prefs }, drafts: {} });
  const r = await render(h(DiffPanel, { cwd, threadId }));
  await settle(act);
  return r;
}
const sections = (host: HTMLElement) => [...host.querySelectorAll('.cp-file')].map((s) => s.getAttribute('data-path'));
const label = (host: HTMLElement, l: string) => one(host, `[aria-label="${l}"]`);
/** A segment of the Unified | Split control, by the label the user reads on it. */
const mode = (host: HTMLElement, name: 'Unified' | 'Split') => one(host, '.cp-mode button', name);
const menuItem = (host: HTMLElement, text: string) => one(host, '[role="menuitem"]', text);
const turn = (diff: string, id = 'turn1') => ({ id, items: [], status: 'completed', diff });

export const setConfirmAnswer = (answer: boolean) => {
  confirmAnswer = answer;
};
export {
  store,
  calls,
  freshReads,
  BASE_SHA,
  gitRoots,
  ok,
  fail,
  DIFF,
  git,
  native,
  h,
  act,
  DiffPanel,
  LangIcon,
  confirms,
  scrolled,
  mount,
  sections,
  label,
  mode,
  menuItem,
  turn,
  one,
  byText,
  settle,
  render,
  typeInto,
};
