// src/harness/codexBinaries.ts: the Codex installs main finds, read once per visit, so Codex's page header and its
// Version row name the install from one answer, and leaving and coming back reads again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, flush } from './support/harness-ui-kit.ts';
import { installNativeStub } from './support/ports/native.ts';

const { createElement: h } = await import('react');
const reads: { resolve: (v: any) => void; reject: (e: unknown) => void }[] = [];
installNativeStub({ codex: { binaries: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) } });
const { useCodexBinaries } = await import('../src/harness/codexBinaries.ts');

const seen: Record<string, any> = {};
const View = ({ name }: { name: string }) => ((seen[name] = useCodexBinaries()), null);
const answer = { candidates: [{ path: '/a/codex', version: '0.163.0' }], current: '/a/codex' };

test('views open at once share one read; the next visit reads again', async () => {
  const header = await mount(h(View, { name: 'header' }));
  const row = await mount(h(View, { name: 'row' }));
  assert.equal(reads.length, 1, 'the Version row reuses the header’s read');
  reads[0].resolve(answer);
  await flush();
  assert.deepEqual([seen.header.bins, seen.row.bins], [answer, answer]);
  await row.unmount();
  // still on the page: a row opened again reuses the answer
  const again = await mount(h(View, { name: 'again' }));
  await flush();
  assert.equal(reads.length, 1);
  assert.deepEqual(seen.again.bins, answer);
  await again.unmount();
  await header.unmount();
  // left and came back: main is asked again
  const next = await mount(h(View, { name: 'next' }));
  assert.equal(reads.length, 2);
  await next.unmount();
});

test('a failed lookup says why; a view gone before the answer takes nothing', async () => {
  reads.length = 0;
  const gone = await mount(h(View, { name: 'gone' }));
  await gone.unmount();
  reads[0].resolve(answer);
  await flush();
  assert.equal(seen.gone.bins, null);
  const v = await mount(h(View, { name: 'failing' }));
  reads[1].reject(new Error('which failed'));
  await flush();
  assert.deepEqual([seen.failing.bins, seen.failing.error], [null, 'which failed']);
  await v.unmount();
  // an unmounted view's failure is dropped too
  const g2 = await mount(h(View, { name: 'gone2' }));
  await g2.unmount();
  reads[2].reject(new Error('late'));
  await flush();
  assert.equal(seen.gone2.error, null);
});
