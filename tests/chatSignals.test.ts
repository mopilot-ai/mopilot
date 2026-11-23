// What a harness says about a chat that the Chrome side panel shows above its composer, read from each harness's own words (shared/chatSignals.mjs): a refusal and a usage-window warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_WARN_AT,
  REFUSAL_TEXT,
  claudeLimitWarning,
  codexLimitWarning,
  codexRefusalNote,
  claudeWarningWindow,
  isClaudeRefusal,
  isClaudeRefusalNotice,
  warningHolds,
} from '../shared/chatSignals.mjs';

const NOW = 1_000_000_000_000;
const inAnHour = Math.floor(NOW / 1000) + 3600;

test('a Claude Code assistant frame that ends on the refusal stop reason is a refusal, with or without an error flag; partial frames are not', () => {
  const frame = (over: object, stop: string | null = 'refusal') => ({ type: 'assistant', message: { stop_reason: stop }, ...over });
  assert.equal(isClaudeRefusal(frame({ error: 'invalid_request' })), true);
  assert.equal(isClaudeRefusal(frame({ isApiErrorMessage: true })), true);
  assert.equal(isClaudeRefusal(frame({})), true);
  // a streamed partial frame has no stop reason yet; an ordinary stop is no refusal
  assert.equal(isClaudeRefusal(frame({}, null)), false);
  assert.equal(isClaudeRefusal(frame({ error: 'rate_limit' }, 'stop_sequence')), false);
  assert.equal(isClaudeRefusal({ type: 'user', message: { stop_reason: 'refusal' }, error: 'x' }), false);
  assert.equal(isClaudeRefusal(null), false);
});

test('the SDK’s structured refusal notice is the other word for a refusal', () => {
  assert.equal(isClaudeRefusalNotice({ type: 'system', subtype: 'model_refusal_no_fallback' }), true);
  assert.equal(isClaudeRefusalNotice({ type: 'system', subtype: 'model_refusal_fallback' }), false);
  assert.equal(isClaudeRefusalNotice({ type: 'assistant', subtype: 'model_refusal_no_fallback' }), false);
  assert.equal(isClaudeRefusalNotice(undefined), false);
});

test('the window a rate limit info is about, whatever its status; none for extra usage or an unnamed window', () => {
  for (const [rateLimitType, window] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
    ['seven_day_opus', '7d'],
  ])
    assert.equal(claudeWarningWindow({ status: 'allowed', rateLimitType }), window);
  assert.equal(claudeWarningWindow({ status: 'rejected', rateLimitType: 'five_hour' }), '5h');
  for (const rateLimitType of ['overage', 'seven_day_overage_included', 'toString', undefined])
    assert.equal(claudeWarningWindow({ rateLimitType }), null);
  assert.equal(claudeWarningWindow(null), null);
});

test('a Codex turn that failed on a policy refusal leaves a refusal note named for the turn, in the app-server words when it gave some', () => {
  const turn = (info: unknown, message?: unknown) => ({ id: 't1', error: { codexErrorInfo: info, message } });
  assert.deepEqual(codexRefusalNote(turn('cyberPolicy', '  Flagged by safety checks  ')), {
    type: 'statusNote',
    id: 'refusal-t1',
    kind: 'refusal',
    text: 'Flagged by safety checks',
  });
  assert.equal(codexRefusalNote(turn('misalignmentPolicyViolation'))?.text, REFUSAL_TEXT);
  assert.equal(codexRefusalNote(turn('cyberPolicy', 7))?.text, REFUSAL_TEXT);
  // a quota, transport or auth failure is not a refusal; neither is a turn with no error, no id, or an object-shaped error info
  for (const info of ['usageLimitExceeded', 'unauthorized', { httpConnectionFailed: { httpStatusCode: 500 } }, null])
    assert.equal(codexRefusalNote(turn(info)), null);
  assert.equal(codexRefusalNote({ id: 't1' }), null);
  assert.equal(codexRefusalNote({ error: { codexErrorInfo: 'cyberPolicy' } }), null);
  assert.equal(codexRefusalNote(undefined), null);
});

test('a warning holds until its window resets; one with no reset time holds until the harness says otherwise', () => {
  assert.equal(warningHolds(null, NOW), false);
  assert.equal(warningHolds({ kind: 'approaching', window: '5h', resetsAt: NOW + 1 }, NOW), true);
  assert.equal(warningHolds({ kind: 'approaching', window: '5h', resetsAt: NOW }, NOW), false);
  assert.equal(warningHolds({ kind: 'approaching', window: '5h', resetsAt: null }, NOW), true);
});

test('Claude Code: allowed_warning names the window, its reset in ms and the used fraction; every other status, window or reset is none', () => {
  const info = (over: object) => ({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: inAnHour, ...over });
  assert.deepEqual(claudeLimitWarning(info({}), NOW), { kind: 'approaching', window: '5h', resetsAt: inAnHour * 1000, utilization: 0.9 });
  for (const [type, window] of [
    ['seven_day', '7d'],
    ['seven_day_opus', '7d'],
    ['seven_day_sonnet', '7d'],
  ])
    assert.equal(claudeLimitWarning(info({ rateLimitType: type }), NOW)?.window, window);
  // no reset time: it holds; a utilization outside 0..1 is clamped, a missing one left out
  assert.deepEqual(claudeLimitWarning(info({ resetsAt: undefined, utilization: undefined }), NOW), {
    kind: 'approaching',
    window: '5h',
    resetsAt: null,
  });
  assert.equal(claudeLimitWarning(info({ utilization: 4 }), NOW)?.utilization, 1);
  assert.equal(claudeLimitWarning(info({ utilization: -1 }), NOW)?.utilization, 0);
  assert.equal(claudeLimitWarning(info({ utilization: 'x' }), NOW)?.utilization, undefined);
  // allowed or refused is no approach; a window the CLI does not name, or the extra-usage-included one, has no banner words
  assert.equal(claudeLimitWarning(info({ status: 'allowed' }), NOW), null);
  assert.equal(claudeLimitWarning(info({ status: 'rejected' }), NOW), null);
  assert.equal(claudeLimitWarning(info({ rateLimitType: undefined }), NOW), null);
  assert.equal(claudeLimitWarning(info({ rateLimitType: 'seven_day_overage_included' }), NOW), null);
  // extra usage (overage) is no plan window: nothing to say, whatever its status
  assert.equal(claudeLimitWarning(info({ rateLimitType: 'overage' }), NOW), null);
  assert.equal(claudeLimitWarning(info({ rateLimitType: 'toString' }), NOW), null);
  // a window that already reset
  assert.equal(claudeLimitWarning(info({ resetsAt: Math.floor(NOW / 1000) - 1 }), NOW), null);
  assert.equal(claudeLimitWarning(undefined, NOW), null);
});

test('Codex: the most used window from the warning step up that is not used up; none when a window is used up or none is near', () => {
  const w = (usedPercent: number, windowDurationMins: number | null, resetsAt: number | null = inAnHour) => ({
    usedPercent,
    windowDurationMins,
    resetsAt,
  });
  const at = (primary: unknown, secondary: unknown) => codexLimitWarning({ primary, secondary }, NOW);
  assert.equal(CODEX_WARN_AT, 75);
  assert.deepEqual(at(w(90, 300), w(10, 10080)), { kind: 'approaching', window: '5h', resetsAt: inAnHour * 1000, utilization: 0.9 });
  assert.equal(at(w(20, 300), w(80, 10080))?.window, '7d');
  // the more used of two near windows
  assert.equal(at(w(80, 300), w(95, 10080))?.window, '7d');
  assert.equal(at(w(95, 300), w(80, 10080))?.window, '5h');
  // exactly the step warns; below it does not
  assert.equal(at(w(75, 300), null)?.window, '5h');
  assert.equal(at(w(74.9, 300), null), null);
  // used up is the limit itself, whatever else is close; a used-up window that already reset is not
  assert.equal(at(w(100, 300), w(90, 10080)), null);
  assert.equal(at(w(100, 300, Math.floor(NOW / 1000) - 5), w(90, 10080))?.window, '7d');
  // a warned window that already reset says nothing; one with no reset time holds
  assert.equal(at(w(90, 300, Math.floor(NOW / 1000) - 5), null), null);
  assert.equal(at(w(90, 300, null), null)?.resetsAt, null);
  // no duration: the window's usual place (the short one first); an odd duration is no window the banner names
  assert.equal(at(w(90, null), null)?.window, '5h');
  assert.equal(at(null, w(90, null))?.window, '7d');
  assert.equal(at(w(90, 1440), null), null);
  assert.equal(at(w(90, 360), null)?.window, '5h');
  assert.equal(at({ usedPercent: 'x' }, undefined), null);
  assert.equal(codexLimitWarning(null, NOW), null);
});
