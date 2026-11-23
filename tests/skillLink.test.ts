// Inline skill links (src/components/markdown/SkillLink.tsx): display names from agents/openai.yaml, and opening.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { popoverStubs, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: unknown[][] = [];
const files: Record<string, string | null | Error> = {};
installNativeStub({
  fs: {
    readText: async (p: string) => {
      calls.push(['read', p]);
      const v = files[p];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
  },
});
stubStore({ openPaneTab: (kind: string, tab: unknown) => calls.push(['tab', kind, tab]) });
mock.module('../src/session/open.ts', {
  namedExports: { openPath: (p: string) => calls.push(['open', p]), revealPath: (p: string) => calls.push(['reveal', p]) },
});
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: (t: string) => calls.push(['copy', t]) } });
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStubs() });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SkillLink, openSkill } = await import('../src/components/markdown/SkillLink.tsx');
const { SkillGlyph } = await import('../src/components/markdown/SkillGlyph.tsx');

const yaml = (dir: string) => `${dir}/agents/openai.yaml`;
async function label(path: string, children?: string) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(SkillLink, { path }, children)));
  await act(async () => {});
  const text = host.querySelector('span')!.textContent;
  return { text, host, root };
}

test('display names: plain, double- or single-quoted, missing, malformed or unreadable', async () => {
  files[yaml('/s/plain')] = 'interface:\n  display_name: Code Review  \n';
  files[yaml('/s/dq')] = '  display_name: "Say \\"hi\\""';
  files[yaml('/s/bad')] = '  display_name: "broken';
  files[yaml('/s/sq')] = "  display_name: 'It''s'";
  files[yaml('/s/half')] = "  display_name: 'open";
  files[yaml('/s/err')] = new Error('denied');
  const cases: [string, string][] = [
    ['/s/plain', 'Code Review'],
    ['/s/dq', 'Say "hi"'],
    ['/s/bad', 'bad'],
    ['/s/sq', "It's"],
    ['/s/half', "'open"],
    ['/s/err', 'err'],
    ['/s/none', 'none'],
  ];
  for (const [dir, want] of cases) {
    const m = await label(`${dir}/SKILL.md`);
    assert.equal(m.text, want, dir);
    await act(() => m.root.unmount());
  }
});

test('a read that failed is tried again next time', async () => {
  files[yaml('/s/flaky')] = new Error('busy');
  let m = await label('/s/flaky/SKILL.md');
  assert.equal(m.text, 'flaky');
  await act(() => m.root.unmount());
  files[yaml('/s/flaky')] = '  display_name: Flaky';
  m = await label('/s/flaky/SKILL.md');
  assert.equal(m.text, 'Flaky', 'the failure was not cached');
  await act(() => m.root.unmount());
});

test('a name is read once per path, and given text other than the skill name is kept', async () => {
  calls.length = 0;
  let m = await label('/s/plain/SKILL.md', 'plain');
  assert.equal(m.text, 'Code Review');
  await act(() => m.root.unmount());
  assert.equal(calls.length, 0);
  m = await label('/s/plain/SKILL.md', 'my words');
  assert.equal(m.text, 'my words');
  await act(() => m.root.unmount());
});

test('a name that arrives after unmount is dropped', async () => {
  let release!: (v: string) => void;
  files[yaml('/s/slow')] = new Promise<string>((r) => {
    release = r;
  }) as any;
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(SkillLink, { path: '/s/slow/SKILL.md' })));
  assert.equal(host.querySelector('span')!.textContent, 'slow');
  await act(() => root.unmount());
  release('  display_name: Slow');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(host.innerHTML, '');
});

test('clicking opens the skill pane; with the modifier it opens the file', async () => {
  const m = await label('/s/plain/SKILL.md');
  const a = m.host.querySelector('a')!;
  calls.length = 0;
  await act(() => a.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }) as any));
  await act(() => a.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }) as any));
  assert.deepEqual(calls, [
    ['tab', 'skill', { path: '/s/plain/SKILL.md', title: 'plain' }],
    ['open', '/s/plain/SKILL.md'],
  ]);
  await act(() => m.root.unmount());
  openSkill('/x/y/SKILL.md');
  assert.deepEqual(calls.at(-1), ['tab', 'skill', { path: '/x/y/SKILL.md', title: 'y' }]);
});

test('the glyph takes a size', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  assert.match(renderToStaticMarkup(createElement(SkillGlyph)), /width="16"/);
  assert.match(renderToStaticMarkup(createElement(SkillGlyph, { size: 12 })), /width="12"/);
});

test('an inline skill link reveals its file from the keyboard without losing its own click', async () => {
  calls.length = 0;
  const m = await label('/s/plain/SKILL.md');
  try {
    const link = m.host.querySelector('a')!;
    assert.equal(link.getAttribute('aria-haspopup'), 'menu');
    await act(async () => link.click());
    assert.deepEqual(calls.at(-1), ['tab', 'skill', { path: '/s/plain/SKILL.md', title: 'plain' }], 'the link still opens the skill pane');
    assert.equal(m.host.querySelector('[role=menu]'), null);
    await act(async () => {
      link.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    });
    const reveal = [...m.host.querySelectorAll('[role=menuitem]')].find((n) => n.textContent?.trim() === 'Reveal in Finder')!;
    await act(async () => (reveal as HTMLElement).click());
    assert.deepEqual(calls.at(-1), ['reveal', '/s/plain/SKILL.md']);
  } finally {
    await act(() => m.root.unmount());
  }
});
