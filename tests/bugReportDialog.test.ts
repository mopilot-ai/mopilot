// src/components/dialogs/BugReportDialog.tsx and src/session/bugReport.ts: a MoPilot-only form without previews, the chat snapshot
// taken at open, retry and save on failure, and sends that end after a close.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

type D = ReturnType<typeof deferred>;
let previews: [any, D][] = [];
let submits: [any, D][] = [];
let openai: [any[], D][] = [];
let saves: [string, string][] = [];
let saveAnswer: () => Promise<string | null> = async () => '/tmp/report.md';
const toasts: any[][] = [];
const opened: string[] = [];
const copies: any[][] = [];
const state: any = {
  threads: {
    mm: { id: 'mm', title: 'MoMo' },
    c1: { id: 'c1', title: 'Fix the build' },
    cl: { id: 'cl', title: 'Claude chat' },
    k1: { id: 'k1', title: 'Kimi chat' },
  },
  runtime: { c1: { settings: { model: 'gpt-5' }, turns: [{ items: [] }] }, cl: { turns: [] } },
  segments: {},
  momoChats: { mm: 'main' },
};
const family: Record<string, string> = { c1: 'codex', cl: 'claude', k1: 'acp', cb: 'codex' };
const kinds: Record<string, string> = { c1: 'codex', cl: 'claude', k1: 'acp:kimi', cb: 'codex' };
state.threads.cb = { id: 'cb', title: 'Old Codex' };
stubStore({
  getState: () => state,
  chatKind: (id: string) => kinds[id],
  chatFamily: (id: string) => family[id],
  blockedReason: (id: string, sem: string) => (id === 'cb' && sem === 'feedback' ? 'Feedback needs a newer Codex' : null),
  threadTitle: (t: any) => t.title,
  sendFeedback: (...a: any[]) => {
    const d = deferred();
    openai.push([a, d]);
    return d.promise;
  },
  toast: (...a: any[]) => toasts.push(a),
  toastFailure: (what: string) => (e: any) => toasts.push([`${what}: ${e.message}`, 'error']),
});
installNativeStub({
  app: {
    bug: {
      preview: (input: any) => {
        const d = deferred();
        previews.push([input, d]);
        return d.promise;
      },
      submit: (input: any) => {
        const d = deferred();
        submits.push([input, d]);
        return d.promise;
      },
    },
  },
  dialog: {
    saveText: (name: string, text: string) => {
      saves.push([name, text]);
      return saveAnswer();
    },
  },
  shell: { openExternal: async (url: string) => void opened.push(url) },
});
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: (...a: any[]) => copies.push(a) } });
mock.module('../src/session/transcript.ts', {
  namedExports: {
    transcriptMarkdown: (title: string, turns: unknown[], label: (n: number) => string) =>
      `# ${title} · ${turns.length} turns · ${label(0)}`,
    labelAt: () => () => 'Codex',
  },
});
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    sessionOf: (id: string) => (id === 'k1' ? { acp: { configOptions: [{ category: 'model', currentValue: 'kimi-k2' }] } } : {}),
  },
});
mock.module('../src/session/harness/acp.ts', {
  namedExports: { acpModelName: (config: any) => config?.find((o: any) => o.category === 'model')?.currentValue ?? null },
});

const { createElement: h, act, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { BugReportDialog } = await import('../src/components/dialogs/BugReportDialog.tsx');
const { native } = await import('../src/lib/native.ts');
const { NEW_ISSUE_URL } = await import('../shared/community.mjs');
const L = { ...(await import('../src/session/bugReport.ts')), ...(await import('../src/lib/bugReportEvent.ts')) };

const report = (o: Record<string, unknown> = {}) => ({
  installId: 'iid',
  kind: 'bug',
  description: '',
  appVersion: '1.2.3',
  os: 'macOS 25',
  arch: 'arm64',
  channel: 'stable',
  harness: 'codex',
  harnessVersion: '0.130.0',
  model: 'gpt-5',
  env: { signedIn: true },
  diagnostics: 'DIAG TEXT',
  transcript: 'TRANSCRIPT TEXT',
  errorFingerprints: ['f'.repeat(32)],
  ...o,
});

let root: any;
let host: HTMLElement;
let closed = 0;
async function open(threadId: string | null, kind?: string, strict = false) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const dialog = h(BugReportDialog, { request: { threadId, kind } as any, onClose: () => closed++ });
  await act(() => root.render(strict ? h(StrictMode, null, dialog) : dialog));
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (text: string) => act(async () => button(text).click());
const settle = (d: D, v: unknown, fail = false) =>
  act(async () => {
    if (fail) d.reject(v);
    else d.resolve(v);
  });
function type(value: string) {
  const el = host.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}
const checkbox = () => host.querySelector('input[type=checkbox]') as HTMLInputElement | null;
afterEach(async () => {
  if (root) await act(() => root.unmount());
  root = null;
  host?.remove();
  previews = [];
  submits = [];
  openai = [];
  saves = [];
  toasts.length = 0;
  copies.length = 0;
  closed = 0;
  saveAnswer = async () => '/tmp/report.md';
  opened.length = 0;
  delete (native as any).mopilotService;
});

for (const threadId of ['c1', 'cl', 'k1', 'cb', null]) {
  test(`bug form uses only MoPilot without a preview for ${threadId ?? 'no chat'}`, async () => {
    await open(threadId);
    assert.equal(checkbox(), null);
    assert.equal(host.querySelector('details'), null);
    assert.doesNotMatch(host.textContent!, /OpenAI|Codex's logs|Preview what will be sent|Preparing the report/);
    assert.equal(previews.length, 0, 'opening the form must not prepare a hidden preview');
    await click('Send');
    assert.equal(submits.length, 1);
    assert.equal(openai.length, 0, 'sending a report must not upload vendor feedback');
    assert.equal(previews.length, 0);
    await settle(submits[0][1], { ok: true, id: 'r1', shortId: 'ABCD1234' });
    assert.match(host.textContent!, /Report ABCD1234 sent to MoPilot/);
    assert.ok(button('Done'));
  });
}

test('a Codex chat: one MoPilot send keeps the snapshot taken at open and reports its result', async () => {
  await open('c1', 'bad_result');
  assert.ok(button('Bad result').className.includes(' on'));
  assert.match(host.textContent!, /This chat's transcript is included/);
  assert.equal(previews.length, 0);
  // the chat changes after the dialog opened: the report keeps what was read then
  state.runtime.c1.turns.push({ items: [] });
  await act(async () => button('Bug').click());
  await act(async () => type('It broke'));
  // two clicks before the dialog re-renders still send once
  await act(async () => {
    button('Send').click();
    button('Send').click();
  });
  state.runtime.c1.turns.pop();
  assert.equal(submits.length, 1);
  assert.deepEqual(submits[0][0], {
    kind: 'bug',
    description: 'It broke',
    harness: 'codex',
    model: 'gpt-5',
    transcript: '# Fix the build · 1 turns · Codex',
  });
  assert.equal(openai.length, 0);
  assert.equal(button('Send').disabled, true);
  assert.equal(host.querySelector('textarea')!.readOnly, true);
  assert.match(host.textContent!, /Sending to MoPilot…/);
  await settle(submits[0][1], { ok: true, id: 'r1', shortId: 'ABCD1234' });
  assert.match(host.textContent!, /Report ABCD1234 sent to MoPilot/);
  await click('Copy ID');
  assert.deepEqual(copies, [['ABCD1234', 'Copied report ID']]);
  assert.equal(button('Save report to file'), undefined);
  await click('Done');
  assert.equal(closed, 1);
});

test('a Claude Code chat: no OpenAI choice; a failed send can be retried or saved to a file', async () => {
  await open('cl');
  assert.equal(checkbox(), null);
  assert.ok(button('Bug').className.includes(' on'));
  assert.equal(previews.length, 0);
  await act(async () => type('Slow'));
  await click('Send');
  assert.deepEqual([submits[0][0].harness, submits[0][0].model], ['claude', null]);
  await settle(submits[0][1], { ok: false, error: { kind: 'rate_limited', message: 'Too many reports. Try again in 30 seconds.' } });
  assert.match(host.textContent!, /Couldn't send to MoPilot: Too many reports\. Try again in 30 seconds\./);
  assert.equal(host.querySelector('textarea')!.readOnly, false);
  await click('Save report to file');
  // what is saved is what main builds for a send now: scrubbed, with the description
  await settle(previews[0][1], report({ harness: 'claude', harnessVersion: null, transcript: '', description: 'Slow' }));
  assert.deepEqual(previews[0][0].description, 'Slow');
  assert.match(saves[0][0], /^mopilot-bug-report-\d{4}-\d{2}-\d{2}\.md$/);
  assert.match(saves[0][1], /- Harness: claude\n/);
  assert.match(saves[0][1], /## What happened\n\nSlow\n/);
  assert.match(saves[0][1], /\(no chat attached\)/);
  assert.deepEqual(toasts.at(-1), ['Saved the report to /tmp/report.md']);
  // the save dialog cancelled: nothing to say; the save failing: says why
  saveAnswer = async () => null;
  await click('Save report to file');
  await settle(previews[1][1], report());
  assert.equal(toasts.length, 1);
  saveAnswer = async () => {
    throw new Error('disk full');
  };
  await click('Save report to file');
  await settle(previews[2][1], report());
  assert.deepEqual(toasts.at(-1), ["Couldn't save the report: disk full", 'error']);
  await click('Save report to file');
  await settle(previews[3][1], new Error('main busy'), true);
  assert.deepEqual(toasts.at(-1), ["Couldn't save the report: main busy", 'error']);
  // a submit that throws (main gone) is a failure in the dialog too, then a retry goes through
  await click('Retry');
  await settle(submits[1][1], new Error("Error invoking remote method 'bug:submit': Error: net::ERR_INTERNET_DISCONNECTED"), true);
  // a sentence, never the IPC wrapper or the network error code (#1863)
  assert.match(host.textContent!, /Couldn't send to MoPilot: You're offline\./);
  assert.equal(host.querySelector('textarea')!.value, 'Slow');
  await click('Retry');
  await settle(submits[2][1], { ok: true, id: 'r2', shortId: 'ZZZZ0000' });
  assert.match(host.textContent!, /Report ZZZZ0000 sent to MoPilot/);
  assert.ok(button('Done'));
});

test('no chat: the dialog says so and sends no transcript; a saved report is built again with the description', async () => {
  await open(null);
  assert.match(host.textContent!, /No chat attached\./);
  assert.equal(checkbox(), null);
  assert.equal(previews.length, 0);
  await click('Send');
  assert.deepEqual(submits[0][0], { kind: 'bug', description: '', harness: null, model: null, transcript: '' });
  await settle(submits[0][1], { ok: false, error: { kind: 'offline', message: 'offline' } });
  await click('Save report to file');
  assert.equal(previews.length, 1);
  await settle(previews[0][1], report({ harness: null, harnessVersion: null, model: null, transcript: '', diagnostics: 'a ``` b' }));
  assert.doesNotMatch(saves[0][1], /- Harness:/);
  // a fence in the diagnostics cannot end the file's own
  assert.match(saves[0][1], /\n````\na ``` b\n````\n/);
  assert.match(saves[0][1], /\(no description\)/);
  await click('Cancel');
  assert.equal(closed, 1);
});

test('a basic harness chat: its harness kind and model, and no OpenAI choice', async () => {
  await open('k1');
  assert.equal(checkbox(), null);
  await click('Send');
  assert.deepEqual([submits[0][0].harness, submits[0][0].model], ['acp:kimi', 'kimi-k2']);
  assert.equal(submits[0][0].transcript, '# Kimi chat · 0 turns · Codex');
  await settle(submits[0][1], { ok: true, id: 'r1', shortId: 'ABCD1234' });
});

test('sends that end after the dialog closed report through a toast', async () => {
  await open('c1');
  await click('Send');
  await act(() => root.unmount());
  root = null;
  await settle(submits[0][1], { ok: true, id: 'r1', shortId: 'ABCD1234' });
  assert.deepEqual(toasts, [['Bug report ABCD1234 sent']]);
  toasts.length = 0;
  await open('c1');
  await click('Send');
  await act(() => root.unmount());
  root = null;
  await settle(submits[1][1], { ok: false, error: { kind: 'server', message: 'HTTP 503' } });
  assert.deepEqual(toasts, [["Your bug report wasn't sent: HTTP 503.", 'error']]);
});

test('Strict Mode: no preview is prepared, one send goes, and its result after a close is still told', async () => {
  await open('c1', undefined, true);
  assert.equal(previews.length, 0);
  await click('Send');
  assert.equal(submits.length, 1);
  await act(() => root.unmount());
  root = null;
  await settle(submits[0][1], { ok: true, id: 'r1', shortId: 'ABCD1234' });
  assert.deepEqual(toasts, [['Bug report ABCD1234 sent']]);
});

test('a dialog opened while an earlier one is still sending keeps its own pending send', async () => {
  await open('c1');
  await click('Send');
  await act(() => root.unmount());
  host.remove();
  await open('cl');
  await click('Send');
  assert.deepEqual(
    submits.map(([i]) => i.harness),
    ['codex', 'claude'],
  );
  // the earlier one ends: it is told in a toast, and the open dialog still waits on its own
  await settle(submits[0][1], { ok: false, error: { kind: 'server', message: 'HTTP 500' } });
  assert.deepEqual(toasts, [["Your bug report wasn't sent: HTTP 500.", 'error']]);
  assert.equal(button('Send').disabled, true);
  assert.doesNotMatch(host.textContent!, /HTTP 500/);
  await settle(submits[1][1], { ok: true, id: 'r2', shortId: 'BBBB2222' });
  assert.match(host.textContent!, /Report BBBB2222 sent to MoPilot/);
});

for (const failed of [false, true]) {
  test(`an earlier send's late ${failed ? 'rejection' : 'success'} leaves the replacement result intact`, async () => {
    await open('c1');
    await click('Send');
    await act(() => root.unmount());
    host.remove();
    await open('cl');
    await click('Send');
    await settle(submits[1][1], { ok: true, id: 'r2', shortId: 'BBBB2222' });
    await settle(submits[0][1], failed ? new Error('late failure') : { ok: true, id: 'r1', shortId: 'AAAA1111' }, failed);
    assert.match(host.textContent!, /Report BBBB2222 sent to MoPilot/);
    assert.doesNotMatch(host.textContent!, /AAAA1111|late failure/);
    assert.ok(button('Done'));
    assert.deepEqual(toasts, [failed ? ["Your bug report wasn't sent: Late failure.", 'error'] : ['Bug report AAAA1111 sent']]);
  });
}

test('openBugReport opens the dialog for a chat, with the kind it starts on', () => {
  const heard: any[] = [];
  const on = (e: Event) => heard.push((e as CustomEvent).detail);
  window.addEventListener(L.OPEN_BUG_REPORT, on);
  L.openBugReport('c1', 'bad_result');
  L.openBugReport(null);
  window.removeEventListener(L.OPEN_BUG_REPORT, on);
  assert.deepEqual(heard, [{ threadId: 'c1', kind: 'bad_result' }, { threadId: null }]);
});

test("chatSnapshot: a MoMo chat's transcript is never attached to a bug report", () => {
  state.runtime.mm = { turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'my landlord' }] }] }] };
  assert.deepEqual(L.chatSnapshot('mm', state), { attached: false, harness: null, model: null, transcript: '' });
  delete state.runtime.mm;
});

test('chatSnapshot: nothing attached for a chat that is gone; the report file names the harness and its version', () => {
  assert.deepEqual(L.chatSnapshot('gone', state), { attached: false, harness: null, model: null, transcript: '' });
  assert.equal(L.chatSnapshot('c1').attached, true);
  assert.equal(L.reportFileName(new Date('2026-10-17T12:00:00Z')), 'mopilot-bug-report-2026-10-17.md');
  const text = L.reportFileText(report({ description: 'Broke', transcript: '# T' }) as any);
  assert.match(text, /- Harness: codex 0\.130\.0\n- Model: gpt-5\n- Install: iid/);
  assert.match(text, /"errorFingerprints": \[/);
  assert.match(text, /## Transcript\n\n# T\n/);
});

test('a build without the MoPilot service saves the report and opens a new issue for it, sending nothing', async () => {
  (native as any).mopilotService = false;
  await open('c1');
  assert.equal(button('Send'), undefined);
  assert.match(host.textContent!, /Attach the file to the issue that opens/);
  await act(async () => type('It broke'));
  await click('Save and open an issue');
  assert.equal(previews.length, 1);
  assert.equal(previews[0][0].description, 'It broke');
  await settle(previews[0][1], report({ description: 'It broke' }));
  assert.equal(saves.length, 1);
  assert.deepEqual(opened, [NEW_ISSUE_URL]);
  assert.deepEqual(toasts.at(-1), ['Saved the report to /tmp/report.md']);
  assert.equal(submits.length, 0, 'nothing is sent');
  // a save the user cancels opens no issue
  saveAnswer = async () => null;
  await click('Save and open an issue');
  await settle(previews[1][1], report());
  assert.deepEqual(opened, [NEW_ISSUE_URL]);
  await click('Cancel');
  assert.equal(closed, 1);
});
