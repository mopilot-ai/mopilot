// The thread's card for a page Claude Code published on claude.ai (src/components/thread/ArtifactCard.tsx): its title, or
// what it is when it has none, whether it is new and its version, and Open and Copy link acting on its link.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, byText } from './support/pages-kit.ts';

const { createElement: h } = await import('react');
const calls: any[] = [];
mock.module('../src/session/open.ts', { namedExports: { openMessageLink: (url: string) => calls.push(['open', url]) } });
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: (t: string, done: string) => calls.push(['copy', t, done]) } });
const { ArtifactCard } = await import('../src/components/thread/ArtifactCard.tsx');

const URL = 'https://claude.ai/code/artifact/0a21f3e3-1b2c-4d5e-8f90-123456789abc';
const ref = (o: any = {}) => ({ url: URL, canonical: URL, kind: 'artifact', title: 'Landing page', version: '2', action: 'created', ...o });

test('a published page shows its title and facts, and Open and Copy link act on its link', async () => {
  const v = await render(h(ArtifactCard, { artifact: ref() as any }));
  assert.equal(v.host.querySelector('.artifact-card-title')?.textContent, 'Landing page');
  assert.equal(v.host.querySelector('.artifact-card-sub')?.textContent, 'Published · version 2 · claude.ai');
  const label = v.host.querySelector('section')?.getAttribute('aria-labelledby');
  assert.ok(label);
  assert.equal(v.host.querySelector('.artifact-card-title')?.id, label, 'the card is named by its own title');
  await click(byText(v.host, 'Open'));
  await click(byText(v.host, 'Copy link'));
  assert.deepEqual(calls, [
    ['open', URL],
    ['copy', URL, 'Copied link'],
  ]);
  await v.unmount();
});

test('a page whose call named no title says what it is; an update with no version says it was updated', async () => {
  let v = await render(h(ArtifactCard, { artifact: ref({ title: null, version: null, action: 'updated' }) as any }));
  assert.equal(v.host.querySelector('.artifact-card-title')?.textContent, 'Artifact');
  assert.equal(v.host.querySelector('.artifact-card-sub')?.textContent, 'Updated · claude.ai');
  await v.unmount();
  v = await render(h(ArtifactCard, { artifact: ref({ kind: 'design', title: null }) as any }));
  assert.equal(v.host.querySelector('.artifact-card-title')?.textContent, 'Claude Design project');
  await v.unmount();
});
