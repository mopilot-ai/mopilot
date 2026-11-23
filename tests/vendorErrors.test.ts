// The vendor control error table (shared/vendorErrors.mjs) and the problems it gives (shared/skyComputerUse.mjs):
// every real vendor wording in tests/fixtures/vendor-error-wordings.json reads as its state, every row is backed
// by one of them, every Sky error code and Browser plugin reason has a decision, every state names a next step,
// codes decide before wording, and an unrecognized vendor stop is a generic state rather than dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SKY_ERROR_CODES, PROBLEM_KINDS, skyProblem, skyProblemOfItem, skyProblemText, vendorProblem } from '../shared/skyComputerUse.mjs';
import {
  SKY_ERRORS_WITHOUT_STATE,
  SKY_MODEL_RECOVERS,
  VENDOR_ERRORS,
  VENDOR_SOURCES,
  vendorErrorByCode,
  vendorErrorByWording,
} from '../shared/vendorErrors.mjs';

type Case = { source: 'cua' | 'claudeInChrome' | 'yourChrome'; status: string; kind: string | null; from: string; text: string };
const { cases } = JSON.parse(readFileSync(new URL('./fixtures/vendor-error-wordings.json', import.meta.url), 'utf8')) as {
  cases: Case[];
};

/** A finished call as the vendor reports it, read through the entry point its source uses. */
function read(c: Case) {
  if (c.source === 'cua')
    return skyProblemOfItem({
      type: 'mcpToolCall',
      server: 'cua_repl',
      status: c.status,
      result: { content: [{ type: 'text', text: c.text }] },
    });
  return vendorProblem(c.text, { sources: VENDOR_SOURCES[c.source], failed: c.status === 'failed' });
}

/** The reasons a BrowserUseSecurityError carries (browser-client.mjs), each with whether the plugin lets the agent retry. */
const BROWSER_USE_REASONS: Record<string, boolean> = {
  approval_cancelled: true,
  approval_failed_closed: true,
  approval_unavailable: true,
  browser_capability_blocked: false,
  browser_capability_unavailable: true,
  browser_context_unavailable: true,
  browser_navigation_blocked: false,
  enterprise_policy_blocked: false,
  enterprise_policy_unavailable: true,
  guardian_denied: false,
  guardian_timed_out: true,
  navigation_url_policy_blocked: false,
  persisted_user_denied: false,
  site_status_blocked: false,
  site_status_unavailable: true,
  user_declined: false,
};

test('every real vendor wording reads as its state, with a next step', () => {
  for (const c of cases) {
    const p = read(c);
    assert.equal(p?.kind ?? null, c.kind, `${c.from}: ${c.text}`);
    if (p) assert.ok(p.hint || p.actions.length, `${c.text}: a next step`);
  }
});

test('every row of the table is backed by a real wording from its vendor', () => {
  for (const row of VENDOR_ERRORS) {
    const sources = row.source === 'claudeInChrome' || row.source === 'yourChrome' ? [row.source] : ['cua'];
    for (const re of row.wordings)
      assert.ok(
        cases.some((c) => sources.includes(c.source) && c.kind === row.kind && re.test(c.text)),
        `${row.source} ${row.kind} ${re}: no fixture`,
      );
  }
  for (const re of SKY_MODEL_RECOVERS)
    assert.ok(
      cases.some((c) => c.kind === null && re.test(c.text)),
      `${re}: no fixture`,
    );
});

test('every Sky error code has a decision: a row of its own, or a raw unknown state; each reads with a next step', () => {
  const named = new Set(VENDOR_ERRORS.filter((r) => r.source === 'sky').flatMap((r) => r.codes));
  for (const name of Object.keys(SKY_ERROR_CODES))
    assert.ok(named.has(name) !== SKY_ERRORS_WITHOUT_STATE.includes(name), `${name}: exactly one of a row or SKY_ERRORS_WITHOUT_STATE`);
  for (const name of [...named, ...SKY_ERRORS_WITHOUT_STATE]) assert.ok(name in SKY_ERROR_CODES, `${name} is a Sky error`);
  for (const [name, code] of Object.entries(SKY_ERROR_CODES)) {
    const p = skyProblem(JSON.stringify({ code }))!;
    assert.equal(p.name, name);
    assert.equal(p.kind === 'unknown', SKY_ERRORS_WITHOUT_STATE.includes(name), name);
    assert.ok(p.title && (p.hint || p.actions.length), `${name}: copy with a next step`);
  }
});

test('every Browser plugin refusal reason maps to a state, retryable ones to the check that was unavailable', () => {
  const rows = VENDOR_ERRORS.filter((r) => r.source === 'browserUse');
  assert.deepEqual(rows.flatMap((r) => r.codes).sort(), Object.keys(BROWSER_USE_REASONS).sort());
  for (const [reason, retryable] of Object.entries(BROWSER_USE_REASONS)) {
    // as JSON, and as Node prints the error
    const printed = skyProblem(JSON.stringify({ name: 'BrowserUseSecurityError', reason, message: 'Browser Use rejected this action.' }))!;
    const inspected = skyProblem(
      `BrowserUseSecurityError: Browser Use rejected this action.\n    at x {\n  decisionSource: 'x',\n  reason: '${reason}'\n}`,
      { failed: true },
    )!;
    for (const p of [printed, inspected]) {
      assert.equal(p.name, reason);
      assert.equal(p.code, null);
      assert.equal(p.kind === 'browserCheckUnavailable', retryable, reason);
    }
    assert.equal(printed.message, 'Browser Use rejected this action.');
  }
});

test('every state has a title and a next step; every row names a state', () => {
  for (const [kind, copy] of Object.entries(PROBLEM_KINDS)) assert.ok(copy.title && (copy.hint || copy.actions.length), kind);
  for (const row of VENDOR_ERRORS) assert.ok(row.kind in PROBLEM_KINDS, row.kind);
  for (const row of VENDOR_ERRORS) assert.ok(Object.isFrozen(row) && Object.isFrozen(row.codes) && Object.isFrozen(row.wordings));
});

test('a code decides before the wording, and only among the rows of the vendor that sent it', () => {
  // the reason says declined, the wording says site-safety: the reason wins
  const p = skyProblem(
    JSON.stringify({
      name: 'BrowserUseSecurityError',
      reason: 'user_declined',
      message: 'Reason: The site-safety policy blocks this action.',
    }),
  )!;
  assert.equal(p.kind, 'browserDeclined');
  assert.equal(vendorErrorByCode([null, undefined, 'nope', 'blockedURL'], VENDOR_SOURCES.cua)!.kind, 'blockedUrl');
  assert.equal(vendorErrorByCode(['blockedURL'], VENDOR_SOURCES.claudeInChrome), null);
  assert.equal(vendorErrorByWording('The Mac is locked.', VENDOR_SOURCES.claudeInChrome), null);
  assert.deepEqual(
    [
      vendorErrorByWording('x\nThe Mac is locked.', VENDOR_SOURCES.cua)!.row.kind,
      vendorErrorByWording('x\nThe Mac is locked.', VENDOR_SOURCES.cua)!.index,
    ],
    ['screenLocked', 2],
  );
  // a known Sky name with no state takes the state of its wording
  assert.equal(skyProblem(JSON.stringify({ errorName: 'unknownError', message: 'The Mac is locked.' }))!.kind, 'screenLocked');
  // a name that is not Sky's own has no code, even one every object has
  const odd = skyProblem(JSON.stringify({ errorName: 'constructor' }))!;
  assert.deepEqual([odd.kind, odd.code, odd.name], ['unknown', null, 'constructor']);
});

test('an unrecognized stop from a Codex control call is a generic state with a next step, not dropped', () => {
  // a vendor stop instruction the table does not know, in a failed call among other output
  const stop = skyProblem(
    'step 1 ok\nThis tab has been stopped for a new reason. Stop your work and send a final message noting why.\nmore',
    {
      failed: true,
    },
  )!;
  assert.deepEqual([stop.kind, stop.title, stop.message], ['stopped', 'Control stopped', 'This tab has been stopped for a new reason.']);
  assert.match(stop.hint!, /bring another tab or app to the front, or do this step yourself/);
  // in a call that completed, only as the whole one-line message
  assert.equal(skyProblem('Proceed. The agent must not attempt to achieve the same outcome via workaround, ever.')!.kind, 'stopped');
  // a printed BrowserUseSecurityError with a reason this table does not know, or none
  const fresh = skyProblem("BrowserUseSecurityError: x\n  reason: 'brand_new_reason'\n}\nPage said: reason = 'user_declined'", {
    failed: true,
  })!;
  assert.deepEqual([fresh.kind, fresh.name, fresh.message], ['stopped', 'brand_new_reason', 'BrowserUseSecurityError: x']);
  const bare = skyProblem('BrowserUseSecurityError: y', { failed: true })!;
  assert.deepEqual([bare.kind, bare.name], ['stopped', null]);
  assert.equal(skyProblem(JSON.stringify({ name: 'BrowserUseSecurityError', message: 'z' }))!.kind, 'stopped');
  // a reason is read from the error's own printout, not from page text after it
  assert.equal(skyProblem("BrowserUseSecurityError: w\n}\nPage said: reason = 'user_declined'", { failed: true })!.name, null);
  // a failed call that only names the Browser plugin
  assert.equal(skyProblem('Browser Use lost the tab', { failed: true })!.kind, 'stopped');
  assert.equal(skyProblem('Browser Use lost the tab', { failed: false }), null);
  // a message that is all instruction to the model is shown as sent rather than emptied
  assert.equal(skyProblem('Stop your work and send a final message.')!.message, 'Stop your work and send a final message.');
});

test('a Codex program that worked and printed page text with vendor words in it reports no problem', () => {
  for (const text of [
    'Page: Browser Use is not permitted on many sites, says the FAQ\nDone',
    'text: Stop your work and send a final message noting why.\nDone',
    'caught BrowserUseSecurityError, switching tab\nDone: 3 items',
    'Docs say: Computer Use permissions are not granted\nDone',
  ])
    assert.equal(skyProblem(text, { failed: false }), null, text);
  // a pause the model recovers from is no problem even with Sky's error name printed on it
  assert.equal(
    skyProblem("SkyComputerUseError: The user is still interacting with 'Notes'. Wait 2 seconds and retry.", { failed: true }),
    null,
  );
});

test("the model's instructions stay in the tool result; the user reads the vendor's message without them", () => {
  const text = cases.find((c) => c.from.startsWith('browser-client.mjs site_status_blocked'))!.text;
  const item = { status: 'failed', result: { content: [{ type: 'text', text }] } };
  const p = skyProblemOfItem(item)!;
  assert.equal(
    p.message,
    'Browser Use rejected this action due to browser security policy. Reason: The site-safety policy blocks this action; no user permission prompt or Auto-review was attempted. Browser Use is not permitted on https://www.wikiwand.com.',
  );
  assert.equal(skyProblemText(p), p.message);
  assert.equal(item.result.content[0].text, text, 'the result the model reads is untouched');
  assert.match(text, /The agent must not attempt to achieve the same outcome via workaround/);
});

test("another vendor's refusal counts when the call failed, or its result is the vendor's sentence from a tool that doesn't read pages", () => {
  const sources = VENDOR_SOURCES.claudeInChrome;
  const blocked = 'This site is not allowed due to safety restrictions.';
  const p = vendorProblem(blocked, { sources, failed: true })!;
  assert.deepEqual(
    [p.kind, p.code, p.name, p.message, p.title],
    ['siteBlocked', null, null, blocked, 'This site is blocked for browser control'],
  );
  assert.equal(vendorProblem(`  ${blocked}`, { sources })!.kind, 'siteBlocked');
  // a page that says the same, read or shown inside other output
  assert.equal(vendorProblem(blocked, { sources, read: true }), null);
  assert.equal(vendorProblem(`Page text:\n${blocked}`, { sources }), null);
  assert.equal(vendorProblem(`Page text:\n${blocked}`, { sources, failed: true })!.message, blocked);
  for (const t of ['Navigated to https://a.test', '', null, 3]) assert.equal(vendorProblem(t as any, { sources, failed: true }), null);
});
