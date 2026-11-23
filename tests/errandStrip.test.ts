// The composer's errand line (src/components/composer/ErrandStrip.tsx): the sites where a chat's ordinary messages are allowed for its
// errand, from main's list and its pushes (another chat's push is ignored, a push that lands before the first read wins), with
// Revoke on each; a failure to read or revoke is told as a toast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { native, mockStore, render, settle, callsTo } from './support/thread-kit.ts';

mockStore();
const io: any[] = [];
let first: any = Promise.resolve([{ site: 'https://store.example', since: 1, browser: 'iab' }]);
let revokeFails = false;
let push: ((e: any) => void) | null = null;
native.browser.errands = (...a: any[]) => (io.push(['errands', ...a]), first);
native.browser.revokeErrand = async (...a: any[]) => {
  io.push(['revokeErrand', ...a]);
  if (revokeFails) throw new Error('main went away');
  return true;
};
native.browser.onErrands = (cb: any) => ((push = cb), () => void (push = null));

const { createElement } = await import('react');
const { ErrandStrip } = await import('../src/components/composer/ErrandStrip.tsx');

test('lists each allowed site with its browser, follows pushes for its chat only, and revokes one', async () => {
  const v = await render(createElement(ErrandStrip, { threadId: 'chat1' }));
  await settle();
  assert.deepEqual(io[0], ['errands', 'chat1']);
  assert.equal(v.$('[data-errand-strip]')!.textContent, 'Messages on store.example allowed for this errandRevoke');
  await settle(() => push!({ chatId: 'other', errands: [] }));
  assert.equal(v.$$('[data-errand-strip]').length, 1, "another chat's push is not this one's");
  await settle(() =>
    push!({
      chatId: 'chat1',
      errands: [
        { site: 'https://store.example', since: 1, browser: 'iab' },
        { site: 'http://127.0.0.1:4100', since: 2, browser: 'chrome' },
      ],
    }),
  );
  const rows = v.$$('[data-errand-strip]');
  assert.equal(rows[1].textContent, 'Messages on 127.0.0.1:4100 allowed for this errand (Chrome)Revoke');
  await settle(() => rows[1].querySelector('button')!.click());
  assert.deepEqual(io.at(-1), ['revokeErrand', 'chat1', 'http://127.0.0.1:4100', 'chrome']);
  // a failed revoke is told
  revokeFails = true;
  await settle(() => v.$$('[data-errand-strip]')[0].querySelector('button')!.click());
  await settle();
  assert.ok(callsTo('store:toast').some((a) => a[1] === 'error'));
  // nothing allowed: no line; unmounting unsubscribes
  await settle(() => push!({ chatId: 'chat1', errands: [] }));
  assert.equal(v.$('[data-errand-strip]'), null);
  await v.unmount();
  assert.equal(push, null);
});

test('a push before the first read wins; a read that fails is told; a late read after unmount does nothing', async () => {
  let resolve: (v: any) => void = () => {};
  first = new Promise((r) => (resolve = r));
  const v = await render(createElement(ErrandStrip, { threadId: 'chat2' }));
  await settle(() => push!({ chatId: 'chat2', errands: [{ site: 'https://new.example', since: 3, browser: 'iab' }] }));
  await settle(() => resolve([{ site: 'https://old.example', since: 1, browser: 'iab' }]));
  assert.match(v.$('[data-errand-strip]')!.textContent!, /new\.example/);
  await v.unmount();
  const before = callsTo('store:toast').length;
  first = Promise.reject(new Error('no main'));
  const w = await render(createElement(ErrandStrip, { threadId: 'chat3' }));
  await settle();
  assert.equal(callsTo('store:toast').length, before + 1);
  // a read still in flight when the line goes: neither its list nor its failure lands
  let late: (v: any) => void = () => {};
  first = new Promise((_r, rej) => (late = rej));
  await w.unmount();
  const x = await render(createElement(ErrandStrip, { threadId: 'chat4' }));
  await x.unmount();
  await settle(() => late(new Error('late')));
  assert.equal(callsTo('store:toast').length, before + 1);
});
