// src/harness/knownIssues.ts: a known problem shows only for an affected, unfixed version this Mac runs, unless a
// version contract run on that version passed its rows; and it says how to get out.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { knownIssueFor, knownIssueExit, KNOWN_ISSUES } = await import('../src/harness/knownIssues.ts');

const issue = (p: any = {}) => ({
  kind: 'codex',
  versions: { from: '0.162.0', below: '0.163.0' },
  text: 'may skip the confirmation for payments inside embedded checkout forms',
  fixedIn: '0.163.0',
  issue: 'https://github.com/mopilot-ai/mopilot-internal/issues/1',
  rows: ['CM-J08'],
  ...p,
});
const run = (p: any = {}) => ({
  kind: 'codex',
  label: 'Codex',
  version: '0.162.1',
  verdict: 'fail',
  date: '',
  regressions: 1,
  known: 0,
  failingRows: ['CM-J08'],
  incomplete: [],
  ...p,
});

test('it shows for a version in range on the right harness, and not outside it or once fixed', () => {
  const list = [issue()];
  assert.equal(knownIssueFor('codex', '0.162.1', list, [])?.rows[0], 'CM-J08');
  assert.equal(knownIssueFor('codex', '0.162.0', list, []) !== null, true);
  assert.equal(knownIssueFor('codex', '0.161.9', list, []), null);
  assert.equal(knownIssueFor('codex', '0.163.0', list, []), null);
  assert.equal(knownIssueFor('claude', '0.162.1', list, []), null);
  // open ranges; a fix below the range end still ends it
  assert.ok(knownIssueFor('codex', '0.1.0', [issue({ versions: { below: '0.163.0' } })], []));
  assert.ok(knownIssueFor('codex', '9.0.0', [issue({ versions: { from: '0.162.0' }, fixedIn: null })], []));
  assert.equal(knownIssueFor('codex', '0.162.5', [issue({ fixedIn: '0.162.3' })], []), null);
});

test('no version, or one that cannot be compared, shows nothing rather than a wrong note', () => {
  const list = [issue()];
  assert.equal(knownIssueFor('codex', null, list, []), null);
  assert.equal(knownIssueFor('codex', undefined, list, []), null);
  assert.equal(knownIssueFor('codex', 'codex-cli (dev build)', list, []), null);
  assert.ok(knownIssueFor('codex', 'v0.162.1', list, []));
});

test('a contract run on that exact version that passed its rows is newer evidence: no note; one that failed them keeps it', () => {
  const list = [issue()];
  assert.equal(knownIssueFor('codex', '0.162.1', list, [run({ failingRows: ['CM-L16'] })]), null);
  assert.ok(knownIssueFor('codex', '0.162.1', list, [run()]));
  // an incomplete run claims nothing, and a run on another version or harness is not about this one
  assert.ok(knownIssueFor('codex', '0.162.1', list, [run({ verdict: 'incomplete', failingRows: [] })]));
  assert.ok(knownIssueFor('codex', '0.162.1', list, [run({ version: '0.162.2', failingRows: [] })]));
  assert.ok(knownIssueFor('codex', '0.162.1', list, [run({ kind: 'claude', failingRows: [] })]));
  // a matrix with no contract runs yet says nothing either way
  assert.ok(knownIssueFor('codex', '0.162.1', list, null as any));
});

test('the way out: the update when it fixes it, else the fixed version, else an earlier one, else none yet', () => {
  assert.equal(knownIssueExit(issue(), 'Codex', '0.163.2'), 'Update to 0.163.2 to fix it.');
  assert.equal(knownIssueExit(issue(), 'Codex', '0.162.9'), 'Use Codex 0.163.0 or newer to fix it.');
  assert.equal(knownIssueExit(issue(), 'Codex', null), 'Use Codex 0.163.0 or newer to fix it.');
  assert.equal(knownIssueExit(issue({ fixedIn: null }), 'Codex', '0.163.2'), 'Use a version before 0.162.0 until it is fixed.');
  assert.equal(knownIssueExit(issue({ fixedIn: null, versions: {} }), 'Codex', null), 'There is no fix yet.');
});

test('the shipped list is well formed, and nothing in it matches by default without a version', () => {
  for (const i of KNOWN_ISSUES) {
    assert.match(i.kind, /^(codex|claude|acp:[a-z0-9-]+)$/);
    assert.ok(i.text && i.issue.startsWith('https://github.com/') && i.rows.every((r) => /^CM-[A-Z]\d+$/.test(r)));
  }
  assert.equal(knownIssueFor('codex', null), null);
});
