// The new-chat page (src/components/pages/Home.tsx): MoPilot's mark, the title for the target project and the basic-harness hint.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

let state: any = {};
let target: any = null;
let gitInfo: (p: string) => Promise<unknown> = async () => ({});
const opened: string[] = [];
installNativeStub({ git: { info: (p: string) => gitInfo(p) } });
stubStore({
  useStore: (f: any) => f(state),
  newChatTarget: () => target,
  codexUsable: (s: any) => s.codex,
  claudeUsable: (s: any) => s.claude,
});
mock.module('../src/harness/launch.ts', { namedExports: { admittedBasics: (b: string[]) => b } });
mock.module('../src/components/pages/Welcome.tsx', { namedExports: { openWelcome: () => opened.push('welcome') } });
mock.module('../src/components/composer/Composer.tsx', { namedExports: { Composer: ({ variant }: any) => `composer:${variant}` } });
const { createElement, act, useState } = await import('react');
mock.module('../src/components/ui/Popover.tsx', {
  namedExports: {
    useAnchor: () => {
      const [open, setOpen] = useState(false);
      return { ref: () => {}, anchor: null, open, setOpen, toggle: () => setOpen((o: boolean) => !o), close: () => setOpen(false) };
    },
  },
});
mock.module('../src/components/composer/ProjectMenu.tsx', {
  namedExports: { ProjectMenu: ({ open }: any) => (open ? 'menu-open' : null) },
});
const { createRoot } = await import('react-dom/client');
const { Home } = await import('../src/components/pages/Home.tsx');

async function mount() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(Home)));
  return { host, root, title: () => host.querySelector('.home-title')!.textContent };
}

test('a git project is built, a plain folder is worked on, and the title opens the project menu', async () => {
  state = { codex: true, claude: true, basicHarnesses: [] };
  target = { path: '/repo', name: 'repo' };
  gitInfo = async () => ({ branch: 'main' });
  let m = await mount();
  const mark = m.host.querySelector('.home-hero .home-mark')!;
  assert.equal(mark.getAttribute('width'), '58');
  assert.ok(mark.querySelector('rect[fill="#1f1f1f"] + path[stroke="#ef8b57"]'), "the hero shows MoPilot's mark, not the Codex cloud");
  assert.equal(m.title(), 'What should we build in repo?');
  assert.match(m.host.textContent!, /composer:home/);
  assert.equal(m.host.querySelector('.home-setup') === null, true);
  await act(() => (m.host.querySelector('.home-project') as HTMLElement).click());
  assert.match(m.host.textContent!, /menu-open/);
  await act(() => m.root.unmount());

  gitInfo = async () => null;
  m = await mount();
  assert.equal(m.title(), 'What should we work on in repo?');
  await act(() => m.root.unmount());

  gitInfo = async () => {
    throw new Error('no git');
  };
  m = await mount();
  assert.equal(m.title(), 'What should we work on in repo?');
  await act(() => m.root.unmount());
});

test('without a project the title is a plain prompt; temporary chats say so', async () => {
  target = null;
  state = { codex: true, claude: false, basicHarnesses: [] };
  let m = await mount();
  assert.equal(m.title(), 'What should we build?');
  await act(() => (m.host.querySelector('.home-project.plain') as HTMLElement).click());
  assert.match(m.host.textContent!, /menu-open/);
  await act(() => m.root.unmount());
  state = { ...state, newChatTemporary: true };
  m = await mount();
  assert.equal(m.title(), 'Temporary chat');
  await act(() => m.root.unmount());
});

test('with only a basic harness it offers to set up Codex or Claude Code', async () => {
  target = null;
  state = { codex: false, claude: false, basicHarnesses: ['kimi'] };
  const m = await mount();
  const link = m.host.querySelector('.home-setup button.text-link') as HTMLElement;
  assert.equal(link.textContent, 'Set up Codex or Claude Code');
  await act(() => link.click());
  assert.deepEqual(opened, ['welcome']);
  await act(() => m.root.unmount());
});
