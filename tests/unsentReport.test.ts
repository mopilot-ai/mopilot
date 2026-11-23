// A window tells main whether a composer holds an unsent draft (src/store/unsentReport.ts), so the app never restarts into an update by itself under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';

const reports: boolean[] = [];
let fail = false;
const stub: any = new Proxy(() => Promise.resolve(undefined), {
  get: (_t, k) => (k === 'then' ? undefined : stub),
  apply: () => Promise.resolve(undefined),
});
const native = new Proxy({} as any, {
  get: (_t, ns) =>
    ns === 'app'
      ? new Proxy({} as any, {
          get: (_a, k) =>
            k === 'unsent' ? (has: boolean) => (reports.push(has), fail ? Promise.reject(new Error('gone')) : Promise.resolve()) : stub,
        })
      : stub,
});
installNativeStub(native);
const { setDraft } = await import('../src/store/core.ts');
await import('../src/store/unsentReport.ts');

test('a draft with text or attachments is reported once, and its clearing once', () => {
  setDraft('c1', { text: '   ', attachments: [] });
  assert.deepEqual(reports, [], 'blank text is no draft');
  setDraft('c1', { text: 'half a thought', attachments: [] });
  setDraft('c1', { text: 'half a thought, more', attachments: [] });
  assert.deepEqual(reports, [true]);
  setDraft('c1', { text: '', attachments: [] });
  assert.deepEqual(reports, [true, false]);
  setDraft('c2', { text: '', attachments: [{ path: '/a.png' } as any] });
  assert.deepEqual(reports, [true, false, true], 'an attachment alone is a draft');
});

test('a report main cannot take is noted, not thrown', async () => {
  fail = true;
  setDraft('c2', { text: '', attachments: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(reports.at(-1), false);
});
