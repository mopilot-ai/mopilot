// Settings › MoMo › Audit log (src/components/momo/settings/TrustRecords.tsx, #2290, #2292): the log's state read from
// main, Export audit log, Start a new log only when the log can't go on, Set aside only when the approvals can't be read,
// each outcome told and the state read again, one action at a time, and a page closed mid-action left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, byText, flush } from './support/shell-chrome-kit.ts';
import { mockSource, popoverStubs, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const toasts: any[] = [];
stubStore({ toast: (text: string, kind = 'info') => toasts.push([text, kind]) });
mockSource('src/lib/ignored.ts', { errorText: (e: any) => e?.message ?? String(e) });
const calls: string[] = [];
const ok = { audit: { state: 'ok', entries: 3 }, approvals: { state: 'ok' } };
let status: () => Promise<any> = async () => ok;
const answers: Record<string, () => Promise<any>> = {
  exportAudit: async () => ({ saved: 'MoMo audit log 2026-10-24.jsonl' }),
  startOverAudit: async () => ({ aside: 'set-aside-1' }),
  setAsideApprovals: async () => ({ keptAs: 'approvals.bin.unreadable-1' }),
  removeSite: async () => ({ removed: true }),
};
const removed: string[] = [];
installNativeStub({
  momoTrust: {
    status: () => (calls.push('status'), status()),
    exportAudit: () => (calls.push('exportAudit'), answers.exportAudit()),
    startOverAudit: () => (calls.push('startOverAudit'), answers.startOverAudit()),
    setAsideApprovals: () => (calls.push('setAsideApprovals'), answers.setAsideApprovals()),
    removeSite: (host: string) => (calls.push('removeSite'), removed.push(host), answers.removeSite()),
  },
});
mockSource('src/components/ui/Popover.tsx', popoverStubs());

const { TrustRecordsSettings, auditDesc } = await import('../src/components/momo/settings/TrustRecords.tsx');

const maybe = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;

test('a log that checks out offers Export only; Export says where it saved, and a cancel says nothing', async () => {
  calls.length = 0;
  toasts.length = 0;
  status = async () => ok;
  const { host, unmount } = await render(h(TrustRecordsSettings));
  await flush();
  assert.match(host.textContent!, /Every action MoMo took, kept on this Mac\./);
  assert.equal(maybe(host, 'Start a new log'), null);
  assert.equal(maybe(host, 'Set aside'), null, 'readable approvals: nothing to choose');
  await click(byText(host, 'Export audit log'));
  await flush();
  assert.deepEqual(toasts, [['Saved MoMo audit log 2026-10-24.jsonl', 'info']]);
  assert.deepEqual(calls, ['status', 'exportAudit', 'status'], 'read again after');
  answers.exportAudit = async () => ({ saved: null });
  await click(byText(host, 'Export audit log'));
  await flush();
  assert.equal(toasts.length, 1, 'cancelled: nothing said');
  await unmount();
});

test('a log that can’t go on says why and offers Start a new log; a refusal is told in main’s words', async () => {
  toasts.length = 0;
  let stuck = true;
  status = async () => ({
    audit: stuck ? { state: 'stuck', reason: "Its key is missing or can't be read, so it can't go on.", exportable: false } : ok.audit,
    approvals: { state: 'ok' },
  });
  const { host, unmount } = await render(h(TrustRecordsSettings));
  await flush();
  assert.match(host.textContent!, /Its key is missing/);
  assert.equal(maybe(host, 'Export audit log'), null, 'nothing to export without its key');
  answers.startOverAudit = async () => {
    stuck = false;
    return { aside: 'set-aside-1' };
  };
  await click(byText(host, 'Start a new log'));
  await flush();
  assert.deepEqual(toasts.at(-1), ['Started a new log. The old one was kept.', 'info']);
  assert.equal(maybe(host, 'Start a new log'), null, 'read again: it goes on now');
  stuck = true;
  await act(async () => void 0);
  const again = await render(h(TrustRecordsSettings));
  await flush();
  answers.startOverAudit = async () => Promise.reject(Object.assign(new Error('MoMo is not available.'), { code: 'not_allowed' }));
  await click(byText(again.host, 'Start a new log'));
  await flush();
  assert.deepEqual(toasts.at(-1), ['MoMo is not available.', 'error']);
  await again.unmount();
  await unmount();
});

test('approvals that can’t be read offer Set aside, one action at a time; the busy button says so', async () => {
  toasts.length = 0;
  let unreadable = true;
  status = async () => ({ audit: ok.audit, approvals: unreadable ? { state: 'unreadable' } : { state: 'ok' } });
  let release: () => void = () => {};
  answers.setAsideApprovals = () =>
    new Promise((r) => {
      release = () => {
        unreadable = false;
        r({ keptAs: 'approvals.bin.unreadable-1' });
      };
    });
  const { host, unmount } = await render(h(TrustRecordsSettings));
  await flush();
  assert.match(host.textContent!, /They can't be read\. Set them aside to start empty\./);
  await click(byText(host, 'Set aside'));
  assert.equal(maybe(host, 'Setting aside…')!.disabled, true);
  assert.equal(maybe(host, 'Export audit log')!.disabled, true, 'one action at a time');
  calls.length = 0;
  await act(async () => byText(host, 'Setting aside…').click());
  assert.deepEqual(calls, [], 'a second click starts nothing');
  await act(async () => release());
  await flush();
  assert.deepEqual(toasts.at(-1), ['Set aside. MoMo asks again from now on.', 'info']);
  assert.equal(maybe(host, 'Set aside'), null);
  await unmount();
});

test('no encryption: said, nothing offered; a status that fails is said; a page closed mid-action is left alone', async () => {
  assert.equal(auditDesc(null, null), 'Checking…');
  assert.equal(auditDesc({ state: 'unavailable', reason: 'Another MoPilot is using it.' }, null), 'Another MoPilot is using it.');
  status = async () => ({
    audit: { state: 'unavailable', reason: 'Another MoPilot is using it.' },
    approvals: { state: 'unavailable', reason: 'Another MoPilot is using them.' },
  });
  const a = await render(h(TrustRecordsSettings));
  await flush();
  assert.equal(a.host.querySelectorAll('button').length, 0);
  assert.match(a.host.textContent!, /Another MoPilot is using them\./, 'the approvals say why too');
  await a.unmount();
  // a state read once, then a read that fails: nothing is offered on what can't be read now
  let fail = false;
  status = async () => (fail ? Promise.reject(new Error("MoMo hasn't started yet.")) : ok);
  const b = await render(h(TrustRecordsSettings));
  await flush();
  fail = true;
  await click(byText(b.host, 'Export audit log'));
  await flush();
  assert.match(b.host.textContent!, /MoMo hasn't started yet\./);
  assert.equal(b.host.querySelectorAll('button').length, 0);
  await b.unmount();
  // closed while the status is read, and while an export runs
  let answer: (v: any) => void = () => {};
  status = () => new Promise((r) => (answer = r));
  const c = await render(h(TrustRecordsSettings));
  await c.unmount();
  await act(async () => answer(ok));
  let refuse: (e: Error) => void = () => {};
  status = () => new Promise((_r, reject) => (refuse = reject));
  const d = await render(h(TrustRecordsSettings));
  await d.unmount();
  await act(async () => refuse(new Error('late')));
  await flush();
  status = async () => ok;
  let saved: (v: any) => void = () => {};
  answers.exportAudit = () => new Promise((r) => (saved = r));
  const e = await render(h(TrustRecordsSettings));
  await flush();
  calls.length = 0;
  await click(byText(e.host, 'Export audit log'));
  await e.unmount();
  await act(async () => saved({ saved: 'x.jsonl' }));
  await flush();
  assert.deepEqual(calls, ['exportAudit'], 'not read again once the page is gone');
});

test('#3655: the always-allowed sites are listed, each with Remove, which forgets it and reads the list again', async () => {
  calls.length = 0;
  toasts.length = 0;
  let sites = ['news.example', 'www.ycombinator.com'];
  status = async () => ({ ...ok, sites });
  const { host, unmount } = await render(h(TrustRecordsSettings));
  await flush();
  assert.match(host.textContent!, /Sites MoMo may open/);
  assert.match(host.textContent!, /www\.ycombinator\.com/);
  answers.removeSite = async () => {
    sites = ['news.example'];
    return { removed: true };
  };
  const remove = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Remove');
  assert.equal(remove.length, 2);
  await click(remove[1]);
  await flush();
  assert.deepEqual(removed, ['www.ycombinator.com']);
  assert.deepEqual(toasts, [['Removed www.ycombinator.com', 'info']]);
  assert.equal(host.textContent!.includes('www.ycombinator.com'), false);
  answers.removeSite = async () => {
    sites = [];
    return { removed: true };
  };
  await click(byText(host, 'Remove'));
  await flush();
  assert.equal(host.textContent!.includes('Sites MoMo may open'), false, 'no group without sites');
  await unmount();
});
