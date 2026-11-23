import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// rateReply with its app modules stubbed: a failed Codex feedback upload must not be thanked as sent.
const fixture: any = { harness: 'codex', consent: true, upload: async () => {}, uploads: [], toasts: [], tracked: [], reports: [] };
(globalThis as any).__chatActions = fixture;
const url = new URL('../src/session/chatActions.ts', import.meta.url).href;
const f = 'const f=globalThis.__chatActions;';
const stubs: Record<string, string> = {
  '../store/chats':
    f + 'export const chatFamily=()=>f.harness; export const usageHarnessOf=()=>f.harness; export const openSettings=()=>()=>{};',
  // these chats run on this Mac
  '../lib/hostChats': 'export const hostOfChatNow=()=>""; export const onMachineNow=()=>false;',
  '../store/core': f + 'export const get=()=>({prefs:{shareUsageData:f.consent}}); export const toast=(...a)=>{f.toasts.push(a);};',
  '../store/connection': f + 'export const sendFeedback=(...a)=>{f.uploads.push(a);return f.upload();};',
  '../lib/telemetry': f + 'export const sendRating=(...a)=>{f.tracked.push(a);};',
  '../harness/accounts': 'export const signInAccountFor=()=>null;',
  './harness/claude': 'export const recheckClaude=()=>{}; export const reloginClaudeAccount=()=>{};',
  '../lib/bugReportEvent': f + 'export const openBugReport=(...a)=>{f.reports.push(a);};',
  './harness/acp': 'export const basicAuthRecovery=()=>null;',
  '../harness/types': 'export const isClaudeAuthError=()=>false;',
};
registerHooks({
  resolve(s, c, next) {
    if (c.parentURL === url && stubs[s]) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(stubs[s]) };
    if (c.parentURL === url && s === './ratings') return next(s + '.ts', c);
    return next(s, c);
  },
});
const { rateReply, reportBadReply } = await import(url);

beforeEach(() =>
  Object.assign(fixture, { harness: 'codex', consent: true, upload: async () => {}, uploads: [], toasts: [], tracked: [], reports: [] }),
);
/** a thumbs down's thanks, which offers the bug report: its action opens it on bad_result for the chat */
function badThanks(chat: string) {
  assert.equal(fixture.toasts.length, 1);
  const [text, kind, opts] = fixture.toasts[0];
  assert.deepEqual([text, kind, opts.action.label], ['Thanks for the feedback', 'info', 'Report a bug…']);
  opts.action.run();
  assert.deepEqual(fixture.reports, [[chat, 'bad_result']]);
}

test('a Codex rating that uploads is thanked and resolves true', async () => {
  assert.equal(await rateReply('chat1', 'good'), true);
  assert.deepEqual(fixture.uploads, [['chat1', 'good_result', null, false]]);
  assert.deepEqual(fixture.toasts, [['Thanks for the feedback']]);
  assert.deepEqual(fixture.tracked, [], 'a Codex rating is not usage data');
});

test('a Codex rating whose upload fails says so instead of thanking, and resolves false', async () => {
  fixture.upload = async () => {
    throw new Error('Network down');
  };
  assert.equal(await rateReply('chat1', 'bad'), false);
  assert.deepEqual(fixture.uploads, [['chat1', 'bad_result', null, false]]);
  assert.deepEqual(fixture.toasts, [["Couldn't send the feedback: Network down", 'error']]);
  assert.deepEqual(fixture.tracked, []);
});

test('a non-Error rejection still names the failure', async () => {
  fixture.upload = () => Promise.reject('offline');
  assert.equal(await rateReply('chat1', 'good'), false);
  assert.deepEqual(fixture.toasts, [["Couldn't send the feedback: offline", 'error']]);
});

test('a Claude rating uploads nothing, is counted as usage data, and is thanked', async () => {
  fixture.harness = 'claude';
  assert.equal(await rateReply('chat1', 'bad'), true);
  assert.deepEqual(fixture.uploads, []);
  assert.deepEqual(fixture.tracked, [[{ harness: 'claude', rating: 'bad' }]]);
  badThanks('chat1');
  // with sharing off the click is the consent to send it: it still goes, and is thanked
  fixture.consent = false;
  fixture.tracked = [];
  fixture.toasts = [];
  assert.equal(await rateReply('chat1', 'good'), true);
  assert.deepEqual(fixture.tracked, [[{ harness: 'claude', rating: 'good' }]]);
  assert.deepEqual(fixture.toasts, [['Thanks for the feedback']]);
});

test('a Codex thumbs down that uploads offers to report a bug; Report a bug… opens it on bad_result', async () => {
  assert.equal(await rateReply('chat2', 'bad'), true);
  badThanks('chat2');
  reportBadReply('chat3');
  assert.deepEqual(fixture.reports.at(-1), ['chat3', 'bad_result']);
});
