// What counts as a Host's refusal in a machine chat's queue, and how it reads from the machine's row now (electron/host/refusalView.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRefusalView, TRANSIENT } = require('../electron/host/refusalView.cjs');

const view = (row: any, kind?: string) => createRefusalView({ rowOf: () => row, kindOf: () => kind, ownerOf: () => ({ hostId: 'box' }) });

test('what the Host answered is a refusal, and so are the two this app gives itself; its own faults are not, whatever the code is called', () => {
  const v = view(undefined);
  const host = (code: string) => Object.assign(new Error('x'), { code, fromHost: true });
  for (const code of ['policy_refused', 'a_code_from_the_future', 'unsupported', 'invalid', 'host_error'])
    assert.equal(v.isRefusal(host(code)), true, code);
  // the app's own refusals of a message (an image it cannot send)
  assert.equal(v.isRefusal(Object.assign(new Error('x'), { code: 'invalid', app: true })), true);
  // this app's own refusals before a message goes
  for (const code of ['directory_missing', 'org_unavailable', 'feature_missing', 'version_refused', 'unsupported'])
    assert.equal(v.isRefusal(Object.assign(new Error('x'), { code })), true, code);
  // transport, a client torn down, an outbox it cannot read, a disk, a subscribe that failed: logged, and the machine's "Waiting for host" says the rest
  for (const code of [...TRANSIENT, 'disposed', 'invalid', 'policy_refused', 'EACCES', 'ENOSPC', ''])
    assert.equal(v.isRefusal(Object.assign(new Error('x'), { code })), false, code);
  for (const code of TRANSIENT) assert.equal(v.isRefusal(host(code)), false, `${code} even when marked`);
  assert.equal(v.isRefusal(new Error('no code')), false);
  assert.equal(v.isRefusal(undefined), false);
  assert.equal(v.isRefusal({ code: 7, fromHost: true }), false);
});

test('the refusal is kept as the Host gave it, with how the agent stood; an acp agent is named without its prefix', () => {
  const row = { name: 'mini', harnesses: [{ id: 'gemini', detected: false, signedIn: false, installable: true }] };
  const v = view(row, 'acp:gemini');
  const kept = v.record('c1', Object.assign(new Error('Nope'), { code: 'harness_not_configured', details: { cause: 'x' } }));
  assert.deepEqual(kept, { code: 'harness_not_configured', message: 'Nope', details: { cause: 'x' }, agentWas: 'missing', own: true });
  const words = v.view('c1', kept);
  assert.deepEqual(words, {
    line: "Gemini isn't installed on mini.",
    action: 'install',
    retry: false,
    agent: 'gemini',
    machine: 'mini',
    hostId: 'box',
  });
  // details that are not an object are dropped, a missing message is empty
  assert.deepEqual(v.record('c1', { code: 'x', details: 'text', fromHost: true }), {
    code: 'x',
    message: '',
    details: undefined,
    agentWas: 'missing',
    own: false,
  });
});

test('a chat on an agent the machine row does not list, or with no row at all, still reads: the machine is "the machine" and a code the table lacks shows the Host’s sentence with Retry', () => {
  const none = view(undefined);
  const w = none.view('c1', { code: 'policy_refused', message: 'This machine does not allow that.' });
  assert.equal(w.line, 'The machine does not allow that.');
  assert.deepEqual([w.agent, w.machine, w.retry], [undefined, 'the machine', true]);
  const unknown = none.view('c1', { code: 'a_code_from_the_future', message: 'Something new.' });
  assert.deepEqual([unknown.line, unknown.action, unknown.retry], ['Something new.', null, true]);
  assert.equal(none.view('c1', { code: 'a_code_from_the_future', message: '' }).line, 'The host refused it.');
  const listed = view({ name: 'mini', harnesses: [] }, 'codex').view('c1', { code: 'harness_not_configured', message: '' });
  assert.equal(listed.line, "Codex isn't set up on mini.");
  assert.equal(none.record('c1', { code: 'x' }).agentWas, null);
  // an agent but no row (the machine was removed): nothing is known of how the agent stands, and nothing is installable
  const removed = view(undefined, 'codex').view('c1', { code: 'harness_not_configured', message: '' });
  assert.deepEqual([removed.line, removed.agent, removed.action], ["Codex isn't set up on the machine.", 'codex', null]);
});

test('this app’s own refusal of a message does not blame the machine and is not offered Retry; the Host’s start reason is, and is', () => {
  const v = view({ name: 'mini', harnesses: [] }, 'codex');
  const app = v.view('c1', v.record('c1', Object.assign(new Error("That image couldn't be read."), { code: 'unsupported', app: true })));
  assert.deepEqual([app.line, app.retry], ["That image couldn't be read.", false]);
  const hosts = v.view(
    'c1',
    v.record('c1', Object.assign(new Error('The model is not available.'), { code: 'unsupported', fromHost: true })),
  );
  assert.deepEqual([hosts.line, hosts.retry], ['mini: The model is not available.', true]);
});
