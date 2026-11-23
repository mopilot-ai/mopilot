// The attention words both clients show (shared/host/attentionLine.mjs): every row of "A chat's attention", the machine states without attention, and an older Host with none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionLine, RESUME_MESSAGE } from '../shared/host/attentionLine.mjs';

const base = { machineName: 'build-box' };

test('approval: the row says Needs you, no strip, no action', () => {
  assert.deepEqual(attentionLine({ ...base, attention: { kind: 'approval' } }), { row: 'Needs you', strip: null, action: null });
});

test('paused for lack of an answer: the row, the strip with the minutes and Resume', () => {
  const paused = { kind: 'paused' as const, reason: 'approval_timeout' };
  assert.deepEqual(attentionLine({ ...base, attention: paused }), {
    row: 'Paused',
    strip: 'Paused: no answer in 30 min',
    action: { kind: 'resume', label: 'Resume' },
  });
  assert.equal(attentionLine({ ...base, attention: paused, pauseMinutes: 120 }).strip, 'Paused: no answer in 2 h');
  assert.equal(attentionLine({ ...base, attention: paused, pauseMinutes: 90 }).strip, 'Paused: no answer in 90 min');
});

test('credential: Sign in on the Mac, no action on the phone', () => {
  const credential = { kind: 'credential' as const };
  const mac = attentionLine({ ...base, attention: credential, client: 'mac' });
  assert.deepEqual(mac, {
    row: 'Needs sign-in',
    strip: 'build-box needs this Mac to sign in again',
    action: { kind: 'signin', label: 'Sign in' },
  });
  assert.equal(attentionLine({ ...base, attention: credential, client: 'phone' }).action, null);
});

test('limit: the amount when known, Raise limit on the Mac only', () => {
  const limit = { kind: 'limit' as const };
  assert.deepEqual(attentionLine({ ...base, attention: limit, limitUsd: 20 }), {
    row: 'Limit reached',
    strip: 'Limit reached: about $20 today',
    action: { kind: 'raise-limit', label: 'Raise limit' },
  });
  assert.equal(attentionLine({ ...base, attention: limit, limitUsd: 4.2 }).strip, 'Limit reached: about $4.20 today');
  assert.equal(attentionLine({ ...base, attention: limit }).strip, 'Limit reached');
  assert.equal(attentionLine({ ...base, attention: limit, client: 'phone' }).action, null);
});

test('no attention: offline, reconnecting and asleep each say their own line', () => {
  assert.deepEqual(attentionLine({ ...base, machine: 'offline' }), { row: 'Offline', strip: 'build-box is offline', action: null });
  assert.deepEqual(attentionLine({ ...base, machine: 'reconnecting', attention: null }), {
    row: null,
    strip: 'Reconnecting to build-box…',
    action: null,
  });
  assert.deepEqual(attentionLine({ machineName: 'dev-cloud', machine: 'asleep' }), {
    row: 'Asleep',
    strip: 'dev-cloud is asleep',
    action: { kind: 'wake', label: 'Wake' },
  });
});

test('an older Host with no attention and a machine that is up shows nothing; attention outranks the machine state', () => {
  assert.deepEqual(attentionLine({ ...base, machine: 'online' }), { row: null, strip: null, action: null });
  assert.deepEqual(attentionLine(base), { row: null, strip: null, action: null });
  assert.equal(attentionLine({ ...base, machine: 'offline', attention: { kind: 'approval' } }).row, 'Needs you');
});

test('Resume sends the one message', () => assert.equal(RESUME_MESSAGE, 'Continue.'));
