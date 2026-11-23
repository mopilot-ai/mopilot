// What a Host's refusal says and offers (shared/host/refusalWords.mjs): every code has a sentence true for its cause that names the machine and, where the agent is the cause, the agent; the action is one the app has; distinct causes never share a sentence; Retry only where the same message can then be accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM
import { REFUSAL_ACTIONS, REFUSAL_CODES, refusalWords } from '../shared/host/refusalWords.mjs';

const base = { machine: 'mopilot-mini', agent: 'codex' };
/** The codes whose sentence is about the message, the chat or the person's own setup, not a machine's state. */
const MACHINELESS = new Set([
  'invalid',
  'org_unavailable',
  'org_signin_required',
  'stale_epoch',
  'chat_released',
  'owner_changed',
  'side_chat_parent_changed',
]);
const words = (code: string, ctx: object = {}) => refusalWords(code, { ...base, ...ctx })!;

test('every code is worded: a sentence that names the machine, an action the app has or none, and a yes or no for Retry', () => {
  for (const code of REFUSAL_CODES as string[]) {
    const w = refusalWords(code, { ...base, message: 'The Host said so.', agentState: 'missing', installable: true })!;
    assert.ok(w, code);
    assert.ok(w.line.length > 0 && w.line.length < 240, `${code}: ${w.line}`);
    if (!MACHINELESS.has(code)) assert.ok(w.line.includes('mopilot-mini'), `${code} names the machine: ${w.line}`);
    assert.ok(w.action === null || REFUSAL_ACTIONS.includes(w.action), `${code}: ${w.action}`);
    assert.equal(typeof w.retry, 'boolean', code);
  }
});

test('a code the table does not know, or none, is not worded: the caller shows the Host’s own sentence', () => {
  assert.equal(refusalWords('a_code_from_the_future', base), null);
  assert.equal(refusalWords(undefined, base), null);
  assert.equal(refusalWords('toString', base), null);
});

test('a side-chat fork timeout names the agent and lets the same message retry', () => {
  assert.deepEqual(words('side_chat_fork_timeout'), {
    line: 'Codex on mopilot-mini took too long to open this side chat.',
    action: null,
    retry: true,
  });
});

test('the one code `harness_not_configured` is told apart by how the agent stands: not installed, signed out, ready since, too old, or not set up', () => {
  const missing = words('harness_not_configured', { agentState: 'missing', installable: true });
  assert.deepEqual(missing, { line: "Codex isn't installed on mopilot-mini.", action: 'install', retry: false });
  // a Host that cannot install it: the sentence says so and nothing in place can fix it
  assert.deepEqual(words('harness_not_configured', { agentState: 'missing' }), { line: missing.line, action: null, retry: false });
  const signedOut = words('harness_not_configured', { agentState: 'signin' });
  assert.deepEqual(signedOut, { line: 'Sign in to Codex on mopilot-mini.', action: 'signIn', retry: false });
  // installed or signed in since the refusal: nothing to do but send again
  const ready = words('harness_not_configured', { agentState: 'ready', agentWas: 'missing' });
  assert.deepEqual(ready, { line: 'Codex is ready on mopilot-mini.', action: null, retry: true });
  assert.equal(words('harness_not_configured', { agentState: 'ready', agentWas: 'signin' }).retry, true);
  const tooOld = words('harness_not_configured', { agentState: 'ready', context: 'continue' });
  assert.deepEqual(tooOld, { line: 'mopilot-mini is too old to take this chat. Update it.', action: 'update', retry: false });
  const unknown = words('harness_not_configured', { agentState: null });
  assert.deepEqual(unknown, { line: "Codex isn't set up on mopilot-mini.", action: null, retry: true });
  const lines = [missing.line, signedOut.line, tooOld.line, unknown.line, ready.line];
  assert.equal(new Set(lines).size, lines.length, 'distinct causes never share a sentence');
  // the facts the Host names itself are the same sentences
  assert.equal(words('agent_missing', { installable: true }).line, missing.line);
  assert.equal(words('agent_signed_out').line, signedOut.line);
  // an agent with no name given is "The agent"
  assert.equal(refusalWords('agent_signed_out', { machine: 'm' })!.line, 'Sign in to The agent on m.');
  // a row that cannot say which: the Host's own sentence is the specific one
  assert.equal(
    words('harness_not_configured', { message: 'Codex is not signed in on this host.' }).line,
    'Codex is not signed in on mopilot-mini.',
  );
});

test('a credential the chat chose and the machine cannot use: each cause its own sentence, by the Host’s `cause` or, from an older Host, by what it said', () => {
  const by = (details: Record<string, unknown>, message?: string) => refusalWords('credential_unavailable', { ...base, details, message })!;
  const names = ['shared', 'key', 'org', 'lease_in_use', 'other_signin'];
  const causes = names.map((cause) => by({ cause }));
  assert.equal(new Set(causes.map((c) => c.line)).size, 5);
  // what the person can clear and then send again: the key, the organization's access, the lease; a chat open on another sign-in or in one shared process cannot
  assert.deepEqual(
    causes.map((c) => [c.action, c.retry]),
    [
      [null, false],
      [null, true],
      ['orgSignIn', true],
      [null, true],
      [null, false],
    ],
  );
  // an older Host sends no cause: its sentence says which
  assert.equal(by({}, "Your organization's access is not available.").line, causes[2].line);
  assert.equal(by({}, 'The key from your Mac is not available.').line, causes[1].line);
  assert.equal(
    by({}, 'This agent runs all its chats in one process on this machine, and that process is using what your Mac lent it.').line,
    causes[0].line,
  );
  // and one that says nothing known: its own sentence with the machine named, or a plain one
  assert.equal(by({}, 'It is not available on this machine.').line, 'It is not available on mopilot-mini.');
  assert.equal(by({}).line, "The credential this chat uses isn't available on mopilot-mini.");
  assert.equal(by({}).retry, false);
  // a login the chat chose: signed out is fixed by signing in; gone or removed is not fixed by anything
  assert.deepEqual([words('login_signed_out').action, words('login_signed_out').retry], ['signIn', true]);
  for (const code of ['login_unavailable', 'login_removed']) assert.deepEqual([words(code).action, words(code).retry], [null, false], code);
  assert.deepEqual([words('login_limited').action, words('login_limited').retry], [null, true]);
});

test('where the Host’s own sentence is the only specific word it is used, with the machine named', () => {
  const policy = refusalWords('policy_refused', {
    ...base,
    message: 'Full access is not allowed on this machine. The most it allows is Auto-review.',
  })!;
  assert.equal(policy.line, 'Full access is not allowed on mopilot-mini. The most it allows is Approve for me.');
  assert.deepEqual([policy.action, policy.retry], [null, true]);
  assert.equal(words('policy_refused').line, "mopilot-mini doesn't allow this.");
  assert.equal(words('spend_limit', { message: 'Limit reached: about $20 today' }).line, 'Limit reached: about $20 today on mopilot-mini.');
  assert.equal(words('spend_limit').line, 'A spend limit holds this chat on mopilot-mini.');
  // `unsupported` carries a start's reason from the Host and may succeed once the cause is gone
  const unsupported = words('unsupported', { message: 'The model is not available to this account.' });
  assert.deepEqual([unsupported.line, unsupported.retry], ['mopilot-mini: The model is not available to this account.', true]);
  assert.equal(words('unsupported').line, "mopilot-mini can't do that.");
  // this app's own refusal of the message (an image it cannot read) does not blame the machine, and sending it again changes nothing
  const own = words('unsupported', { own: true, message: "That image couldn't be read." });
  assert.deepEqual([own.line, own.retry], ["That image couldn't be read.", false]);
  assert.equal(words('invalid').line, "mopilot-mini couldn't read that message.");
  assert.equal(words('invalid', { message: 'Type a message first.' }).line, 'Type a message first.');
  assert.equal(words('org_unavailable', { message: 'The IdP did not answer.' }).line, 'The IdP did not answer.');
  assert.equal(
    words('feature_missing', { message: 'This Host cannot receive images yet. Update it.' }).line,
    'mopilot-mini cannot receive images yet. Update it.',
  );
  assert.equal(words('image_unavailable').line, "mopilot-mini couldn't take the picture.");
  // a fault of the machine's own disk is not "no such picture": the same message may go again
  assert.deepEqual([words('image_fault').line, words('image_fault').retry], ["mopilot-mini couldn't read the picture. Try again.", true]);
  assert.equal(
    words('image_fault', { message: 'The image record could not be read.' }).line,
    'mopilot-mini: The image record could not be read.',
  );
  assert.equal(words('unavailable').line, "mopilot-mini can't do that.");
  assert.equal(words('mode_unavailable', { message: 'It refused' }).line, "Codex on mopilot-mini can't change to that mode: It refused");
  assert.equal(words('mode_unavailable').line, "Codex on mopilot-mini can't change to that mode: it refused");
});

test('folders and storage: the Host says which, the machine is named, and Retry only where the person can make it right and the same message then goes', () => {
  for (const code of [
    'directory_missing',
    'outside_roots',
    'outside_grant',
    'not_a_directory',
    'not_a_file',
    'invalid_path',
    'clone_failed',
    'worktree_failed',
  ]) {
    const w = words(code);
    // a folder that cannot be used: the message goes on in a new chat in another folder; a file, a clone or a worktree is not that
    assert.equal(w.action, ['not_a_file', 'clone_failed', 'worktree_failed'].includes(code) ? null : 'chooseFolder', code);
    assert.equal(w.retry, code === 'directory_missing', code);
    assert.ok(w.line.includes('mopilot-mini'), code);
    assert.equal(words(code, { message: 'No such folder on this host.' }).line, 'No such folder on mopilot-mini.', code);
  }
  assert.equal(words('directory_missing').line, "That folder doesn't exist on mopilot-mini.");
  // the Switch host dialog has its own folder field: no action there
  assert.equal(words('outside_roots', { context: 'continue' }).action, null);
  // the Switch host dialog keeps its own folder sentences and does not prefix the machine it already names
  assert.equal(
    words('directory_missing', { context: 'continue', message: 'Raw message.' }).line,
    "That folder doesn't exist on mopilot-mini.",
  );
  assert.equal(words('unsupported', { context: 'continue', message: 'Raw message.' }).line, 'Raw message.');
  for (const code of [
    'session_storage_unavailable',
    'session_journal_full',
    'session_journal_budget',
    'session_journal_busy',
    'session_journal_delete_failed',
    'session_journal_unreadable',
    'epoch_store_unreadable',
    'owner_store_unreadable',
  ]) {
    const w = refusalWords(code, { machine: 'mopilot-mini' })!;
    assert.equal(w.retry, true, code);
    assert.equal(w.line, "mopilot-mini couldn't save this chat. Check its disk space and permissions.", code);
  }
  assert.equal(
    refusalWords('session_journal_budget', { machine: 'm', message: 'Delete saved chats on this machine.' })!.line,
    'Delete saved chats on m.',
  );
});

test('the rest: an older Host says Update and can then be retried, a chat that moved or was deleted says so, a restart is not sent again blind, and the pairing is the owner’s', () => {
  for (const code of ['feature_missing', 'version_refused'])
    assert.deepEqual([words(code).action, words(code).retry], ['update', true], code);
  for (const code of ['stale_epoch', 'chat_released', 'owner_changed'])
    assert.equal(words(code).line, 'This chat moved to another machine.');
  assert.equal(words('session_journal_deleted').line, 'This chat was deleted from mopilot-mini.');
  assert.equal(words('chat_unknown').line, 'mopilot-mini has no such chat.');
  // after a restart the Host may or may not have taken it: the same key would only be answered "unknown", so the person looks first
  assert.equal(words('request_interrupted').retry, false);
  for (const code of ['read_timed_out', 'history_changed', 'org_unavailable', 'org_identity_busy', 'unknown_client'])
    assert.equal(words(code).retry, true, code);
  for (const code of ['forbidden', 'unknown_client']) assert.equal(words(code).action, 'openMachines', code);
  assert.equal(words('forbidden').retry, false);
  // a chat the machine no longer has or cannot read back: the words go on in a new chat there, and sending again would be refused again
  for (const code of ['chat_unknown', 'session_journal_deleted', 'history_too_large'])
    assert.deepEqual([words(code).action, words(code).retry], ['newChat', false], code);
  for (const code of ['key_reused', 'not_supported']) assert.deepEqual([words(code).action, words(code).retry], [null, false], code);
  assert.equal(words('org_signin_required').action, 'orgSignIn');
  assert.equal(words('org_identity_busy').line.includes('Codex'), true);
});

test('a mode above the owner’s ceiling offers the most the machine allows in one click, and no Retry that would be refused again; any other policy refusal keeps Retry', () => {
  const ceiling = { key: 'permissionMax', max: 'read-only' };
  const useMode = words('policy_refused', {
    agent: 'codex',
    details: ceiling,
    message: 'Default is not allowed on this machine. The most it allows is Read-only.',
  });
  assert.deepEqual([useMode.action, useMode.retry, (useMode as any).mode], ['useMode', false, 'read-only']);
  // the chip's own words, and a sentence that already names the cause, so the row does not front it with "Host did not accept it"
  assert.equal(useMode.line, 'Ask for approval is not allowed on mopilot-mini. The most it allows is Read-only.');
  assert.equal((useMode as any).named, true);
  // a basic agent's modes are its own, a max the app does not know, another rule, and an older Host's refusal with no details: no action
  for (const o of [
    { agent: 'kimi', details: ceiling },
    { agent: 'codex', details: { key: 'permissionMax', max: 'plan' } },
    { agent: 'codex', details: { key: 'harnesses.allow' } },
    { agent: 'codex' },
    { agent: undefined, details: ceiling },
  ]) {
    const w = words('policy_refused', o as any);
    assert.deepEqual([w.action, w.retry, (w as any).mode, (w as any).named], [null, true, undefined, undefined], JSON.stringify(o));
  }
});

test('a Mac the machine does not know says so in one sentence, with its fix and without the Host-did-not-accept prefix', () => {
  const w = words('unknown_client');
  assert.deepEqual([w.line, w.action, w.retry, w.named], ["mopilot-mini doesn't know this Mac.", 'openMachines', true, true]);
  assert.equal(words('forbidden').named, undefined, 'a refusal whose sentence does not name the cause keeps its prefix');
});

test('a key this Mac cannot read says so with what to do, and Retry can succeed', () => {
  const w = words('key_unreadable');
  assert.deepEqual(
    [w.line, w.action, w.retry],
    ["This Mac can't read its key for mopilot-mini. Unlock the keychain, then Retry.", null, true],
  );
});
