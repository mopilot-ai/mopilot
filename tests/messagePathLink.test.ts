// src/components/markdown/MessagePathLink.tsx: inline code becomes a path link (icon, accent text, the path menu) only once
// main finds a file or folder there; a click opens what is there, a Cmd-click a file's app, and plain code stays plain.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { autoMock, render, settle, callsTo, moduleCalls, native } from './support/thread-kit.ts';

autoMock('src/session/open.ts', 'open');
autoMock('src/components/ui/Popover.tsx', 'pop', {
  MenuItem: ({ onSelect, children }: any) => h('button', { 'data-item': children, onClick: onSelect }, children),
});
autoMock('src/components/ui/FileMenu.tsx', 'menu', {
  useFileMenu: (path: string, { extra }: { extra?: unknown }) => ({
    target: { 'data-menu-for': path, onContextMenu: () => moduleCalls.push(['menu:open', [path]]) },
    menu: h('span', { 'data-menu': path }, extra as any),
  }),
});
const { InlineCodePath } = await import('../src/components/markdown/MessagePathLink.tsx');
const { resetMessagePaths } = await import('../src/lib/messagePaths.ts');

const answers: Record<string, any> = {
  '~/Downloads/MoPilot_film_v2/': { path: '/Users/me/Downloads/MoPilot_film_v2', kind: 'dir' },
  'MoPilot_film_9x16.mp4': { path: '/repo/MoPilot_film_9x16.mp4', kind: 'file' },
  'src/a.ts': { path: '/repo/src/a.ts', kind: 'file' },
};
native.fs = { messagePath: async (p: string) => answers[p] ?? null };
beforeEach(() => {
  resetMessagePaths();
  moduleCalls.length = 0;
});
const show = async (text: string) => {
  const v = await render(h(InlineCodePath, { text, cwd: '/repo' }));
  await settle();
  return v;
};

test('a folder that is there: a plain link with the text as written, the full path as its title; a click opens it', async () => {
  const v = await show('~/Downloads/MoPilot_film_v2/');
  const link = v.$('a.md-path')!;
  assert.equal(link.getAttribute('href'), '~/Downloads/MoPilot_film_v2/');
  assert.equal(link.title, '/Users/me/Downloads/MoPilot_film_v2');
  assert.equal(link.querySelector('svg, [data-stub]'), null, "no icon: a plain link, as in Claude's app");
  assert.equal(link.querySelector('code')!.textContent, '~/Downloads/MoPilot_film_v2/');
  await settle(() => link.click());
  assert.deepEqual(callsTo('open:openMessagePath'), [
    ['~/Downloads/MoPilot_film_v2/', '/repo', { line: undefined, endLine: undefined }, false],
  ]);
  // a folder's menu has no default-app item: Reveal in Finder is the menu's own
  assert.equal(v.$('[data-menu] [data-item]'), null);
  await v.unmount();
});

test("a file: its line goes to the opener, a Cmd-click asks for the file's app, the menu adds Open with default app", async () => {
  const v = await show('src/a.ts:12');
  const link = v.$('a.md-path')!;
  assert.equal(link.getAttribute('data-menu-for'), '/repo/src/a.ts');
  await settle(() => link.dispatchEvent(new (link.ownerDocument.defaultView as any).MouseEvent('click', { bubbles: true, metaKey: true })));
  assert.deepEqual(callsTo('open:openMessagePath'), [['src/a.ts', '/repo', { line: 12, endLine: undefined }, true]]);
  await settle(() => v.$('[data-item="Open with default app"]')!.click());
  assert.deepEqual(callsTo('open:openFile'), [['/repo/src/a.ts']]);
  await v.unmount();
});

test('a cited range goes to the opener whole, so the file pane marks every line of it', async () => {
  const v = await show('src/a.ts#L5-L20');
  await settle(() => v.$('a.md-path')!.click());
  assert.deepEqual(callsTo('open:openMessagePath').at(-1), ['src/a.ts', '/repo', { line: 5, endLine: 20 }, false]);
  await v.unmount();
});

test('a bare file name in the chat folder is a link; code that names nothing there, or is no path, stays plain', async () => {
  const film = await show('MoPilot_film_9x16.mp4');
  assert.equal(film.$('a.md-path code')!.textContent, 'MoPilot_film_9x16.mp4');
  await film.unmount();
  for (const text of ['src/missing.ts', 'npm run build']) {
    const v = await show(text);
    assert.equal(v.$('a'), null, text);
    assert.equal(v.$('code')!.className, 'inline-code');
    await v.unmount();
  }
});

test("a click's lookup is the link's own: a file gone by the click turns the link back into plain code", async () => {
  const { lookupMessagePath } = await import('../src/lib/messagePaths.ts');
  const v = await show('MoPilot_film_9x16.mp4');
  delete answers['MoPilot_film_9x16.mp4'];
  await settle(() => v.$('a.md-path')!.click());
  // the real opener (src/session/open.ts) asks main again with what the click passed: the path as written
  const [text, cwd] = callsTo('open:openMessagePath')[0];
  await settle(() => lookupMessagePath(text, cwd));
  assert.equal(v.$('a'), null);
  assert.equal(v.$('code')!.textContent, 'MoPilot_film_9x16.mp4');
  answers['MoPilot_film_9x16.mp4'] = { path: '/repo/MoPilot_film_9x16.mp4', kind: 'file' };
  await v.unmount();
});
