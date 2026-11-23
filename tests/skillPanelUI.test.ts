import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, markdownStub, one, settle } from './support/shell-panels-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({});
type Pending = { resolve: (v: string | null) => void; reject: (e: unknown) => void };
const reads = new Map<string, Pending>();
const calls: unknown[][] = [];
let clipboardOk = true;
const native = {
  fs: { readText: (p: string) => new Promise<string | null>((resolve, reject) => reads.set(p, { resolve, reject })) },
  clipboard: {
    write: async (t: string) => {
      calls.push(['copy', t]);
      if (!clipboardOk) throw new Error('denied');
    },
  },
  shell: {
    reveal: async (p: string) => {
      calls.push(['reveal', p]);
      throw new Error('gone');
    },
  },
};
stubStore(store.exports);
installNativeStub(native);
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: markdownStub({ dark: false }) });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SkillPanel } = await import('../src/components/panels/SkillPanel.tsx');

async function mount(path: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(createElement(SkillPanel, { path })));
  return { host, root, rerender: (p: string) => act(() => root.render(createElement(SkillPanel, { path: p }))) };
}
const resolve = (p: string, v: string | null) =>
  act(async () => {
    reads.get(p)!.resolve(v);
  });
const reject = (p: string, e: unknown) =>
  act(async () => {
    reads.get(p)!.reject(e);
  });

test('a skill renders its metadata and body, and toggles to the raw source', async () => {
  const { host, root } = await mount('/repo/skills/demo/SKILL.md');
  assert.ok(host.querySelector('[aria-label="Loading skill"]'));
  assert.deepEqual(
    [...host.querySelectorAll('.skill-breadcrumb > span')].map((s) => s.textContent),
    ['repo', 'skills', 'demo', 'SKILL.md'],
  );
  assert.equal(host.querySelectorAll('.skill-breadcrumb svg').length, 3);
  assert.equal((one(host, 'button', 'View source') as HTMLButtonElement).disabled, true);
  await resolve('/repo/skills/demo/SKILL.md', '---\nname: demo\ndescription: Does things\n---\n# Body');
  assert.deepEqual(
    [...host.querySelectorAll('.skill-metadata dt')].map((d) => d.textContent),
    ['name', 'description'],
  );
  assert.equal(host.querySelector('[data-markdown]')!.getAttribute('data-markdown'), '/repo/skills/demo');
  assert.equal(host.querySelector('[data-markdown]')!.textContent, '# Body');
  await act(() => one(host, 'button', 'View source').click());
  assert.equal(host.querySelector('pre[data-lang="markdown"]')!.textContent, '---\nname: demo\ndescription: Does things\n---\n# Body');
  assert.equal(one(host, 'button', 'View rendered').getAttribute('aria-pressed'), 'true');
  await act(() => one(host, 'button', 'View rendered').click());
  assert.ok(host.querySelector('[data-markdown]'));
  await act(() => root.unmount());
});

test('a skill without front matter shows only its body', async () => {
  const { host, root } = await mount('/plain.md');
  await resolve('/plain.md', 'just text');
  assert.equal(host.querySelector('.skill-metadata'), null);
  assert.equal(host.querySelector('[data-markdown]')!.textContent, 'just text');
  await act(() => root.unmount());
});

test('missing, oversized and unreadable skills explain the problem', async () => {
  const { host, root, rerender } = await mount('/missing.md');
  await resolve('/missing.md', null);
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /could not be read/);
  await rerender('/big.md');
  assert.equal(host.querySelector('[role="alert"]'), null, 'a new path clears the old error');
  await resolve('/big.md', 'x'.repeat(400_001));
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /too large/);
  await rerender('/err.md');
  await reject('/err.md', new Error('EACCES'));
  assert.equal(host.querySelector('[role="alert"]')!.textContent, 'EACCES');
  await rerender('/str.md');
  await reject('/str.md', 'plain failure');
  assert.equal(host.querySelector('[role="alert"]')!.textContent, 'plain failure');
  await act(() => root.unmount());
});

test('a read that finishes after the path changed is ignored', async () => {
  const { host, root, rerender } = await mount('/old.md');
  await rerender('/new.md');
  await resolve('/old.md', 'stale');
  await reject('/old.md', new Error('stale'));
  assert.ok(host.querySelector('[aria-label="Loading skill"]'));
  await rerender('/old2.md');
  await reject('/new.md', new Error('stale too'));
  assert.equal(host.querySelector('[role="alert"]'), null);
  await act(() => root.unmount());
});

test('copy path and reveal report success and failure with toasts', async () => {
  const { host, root } = await mount('/repo/SKILL.md');
  await act(() => one(host, '[aria-label="Copy skill path"]').click());
  await settle(act);
  clipboardOk = false;
  await act(() => one(host, '[aria-label="Copy skill path"]').click());
  await settle(act);
  await act(() => one(host, '[aria-label="Reveal skill in folder"]').click());
  await settle(act);
  assert.deepEqual(calls, [
    ['copy', '/repo/SKILL.md'],
    ['copy', '/repo/SKILL.md'],
    ['reveal', '/repo/SKILL.md'],
  ]);
  assert.deepEqual(store.calls, [
    ['toast', 'Copied path'],
    ['toast', "Couldn't copy: denied", 'error'],
    ['toast', "Couldn't show SKILL.md: gone", 'error'],
  ]);
  await act(() => root.unmount());
});
