// A message a Host refuses (electron/host/remoteSend.cjs, refusalView.cjs): every refusal becomes a row that says its cause naming the machine and the agent, offers the one action that fixes it, and keeps Retry for what can succeed; only a fault on the way stays a log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, msg, UUID, code } from './support/host/remoteSendKit.ts';

/** A machine's row with Codex on it as `agent` says. */
function machine(w: ReturnType<typeof world>, agent: { detected: boolean; signedIn: boolean; installable?: boolean }) {
  Object.assign(w.row, { name: 'mopilot-mini', harnesses: [{ id: 'codex', ...agent }] });
  w.remote('c1');
  w.kinds.set('c1', 'codex');
}
const refuse = (w: ReturnType<typeof world>, c: string, message = 'The Host said so.', details?: object) =>
  (w.host.failWith = Object.assign(new Error(message), { code: c, ...(details ? { details } : {}) }));
const head = (w: ReturnType<typeof world>) => w.queues.get('c1')![0];

test('an agent the machine lacks: the row says so with Install, and once it is installed the same row says it is ready and offers Retry', async (t) => {
  const w = world(t);
  machine(w, { detected: false, signedIn: false, installable: true });
  refuse(w, 'harness_not_configured');
  await w.service.send('c1', msg('go', UUID(1)), 1);
  assert.equal(head(w).waitingFor, 'hostRefused');
  assert.equal(head(w).error, "Codex isn't installed on mopilot-mini.");
  assert.deepEqual(head(w).refusal, {
    code: 'harness_not_configured',
    action: 'install',
    retry: false,
    hostId: 'box',
    machine: 'mopilot-mini',
    agent: 'codex',
  });
  assert.equal(w.reports.length, 0, 'a refusal is shown, not only logged');
  // the install finished: the registry's next row changes what the row says, with no new refusal
  Object.assign((w.row as any).harnesses[0], { detected: true, signedIn: true });
  await w.rowUp();
  assert.equal(head(w).error, 'Codex is ready on mopilot-mini.');
  assert.deepEqual([head(w).refusal.action, head(w).refusal.retry], [null, true]);
});

test('an agent installed and signed out says Sign in; an agent no Host install can add has no action', async (t) => {
  const w = world(t);
  machine(w, { detected: true, signedIn: false });
  refuse(w, 'harness_not_configured');
  await w.service.send('c1', msg('go', UUID(1)), 1);
  assert.equal(head(w).error, 'Sign in to Codex on mopilot-mini.');
  assert.equal(head(w).refusal.action, 'signIn');
  const x = world(t);
  machine(x, { detected: false, signedIn: false });
  refuse(x, 'harness_not_configured');
  await x.service.send('c1', msg('go', UUID(2)), 1);
  assert.deepEqual([head(x).refusal.action, head(x).refusal.retry], [null, false]);
});

test('refusals that were only a log line now show: the machine’s rules, a spend limit, a credential, a chat that is gone, a full disk', async (t) => {
  const cases: [string, string | undefined, object | undefined, RegExp, string | null, boolean][] = [
    [
      'policy_refused',
      'Full access is not allowed on this machine.',
      { key: 'permissionMax' },
      /^Full access is not allowed on mopilot-mini\.$/,
      null,
      true,
    ],
    ['spend_limit', 'Limit reached: about $20 today', undefined, /^Limit reached: about \$20 today on mopilot-mini\.$/, null, true],
    [
      'credential_unavailable',
      'x',
      { cause: 'org' },
      /^Your organization's access isn't available to Codex on mopilot-mini/,
      'orgSignIn',
      true,
    ],
    ['credential_unavailable', 'x', { cause: 'key' }, /^The key from your Mac isn't available to Codex on mopilot-mini\.$/, null, true],
    ['login_signed_out', undefined, undefined, /signed out on mopilot-mini\.$/, 'signIn', true],
    ['session_journal_deleted', undefined, undefined, /^This chat was deleted from mopilot-mini\.$/, 'newChat', false],
    ['session_storage_unavailable', undefined, undefined, /couldn't save this chat/, null, true],
    ['org_identity_busy', undefined, undefined, /^Codex on mopilot-mini is running another organization/, null, true],
  ];
  for (const [c, message, details, line, action, retry] of cases) {
    const w = world(t);
    machine(w, { detected: true, signedIn: true });
    refuse(w, c, message ?? '', details);
    await w.service.send('c1', msg('go', UUID(1)), 1);
    assert.equal(head(w).waitingFor, 'hostRefused', c);
    assert.match(head(w).error, line, c);
    assert.deepEqual([head(w).refusal.action, head(w).refusal.retry], [action, retry], c);
    assert.equal(w.reports.length, 0, c);
  }
});

test('a code from a newer Host shows its own sentence with Retry; a fault on the way stays the machine’s "Waiting for host" and a log line', async (t) => {
  const w = world(t);
  machine(w, { detected: true, signedIn: true });
  refuse(w, 'a_code_from_the_future', 'Something new happened.');
  await w.service.send('c1', msg('go', UUID(1)), 1);
  assert.equal(head(w).error, 'Something new happened.');
  assert.deepEqual([head(w).refusal.action, head(w).refusal.retry], [null, true]);
  const unreachable = world(t);
  machine(unreachable, { detected: true, signedIn: true });
  unreachable.host.failWith = code('The machine did not answer.', 'host_unreachable');
  await unreachable.service.send('c1', msg('go', UUID(2)), 1);
  assert.notEqual(head(unreachable).waitingFor, 'hostRefused');
  assert.equal(head(unreachable).refusal, undefined);
  assert.equal(unreachable.reports.length, 1);
  // an error with no code at all (a fault in this app) is logged too
  const plain = world(t);
  machine(plain, { detected: true, signedIn: true });
  plain.host.failWith = new Error('disk');
  await plain.service.send('c1', msg('go', UUID(3)), 1);
  assert.notEqual(head(plain).waitingFor, 'hostRefused');
  assert.equal(plain.reports.length, 1);
});

test('the receipt of Send now says the same line, and a machine no longer listed is "the machine"', async (t) => {
  const w = world(t);
  machine(w, { detected: true, signedIn: true });
  refuse(w, 'policy_refused', 'This machine does not allow that agent.');
  await w.service.send('c1', msg('go', UUID(1)), 1);
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'queued', error: 'mopilot-mini does not allow that agent.' });
  const gone = world(t);
  gone.remote('c1');
  refuse(gone, 'forbidden');
  await gone.service.send('c1', msg('go', UUID(2)), 1);
  assert.equal(head(gone).error, "The machine doesn't let this Mac do that.");
  assert.equal(head(gone).refusal.agent, undefined);
  // access is the machine's page in Settings: the row offers it, and no Retry
  assert.deepEqual([head(gone).refusal.action, head(gone).refusal.retry], ['openMachines', false]);
});

test('what is not the Host’s word stays a log line: this app’s own errors with a code of the same name, and a client torn down mid-send', async (t) => {
  // the app's own `invalid` (a subscribe that failed) and `disposed` are not refusals, whatever the table calls those codes
  for (const own of [code('Too much live history arrived. Retry the chat.', 'invalid'), code('This Host was disposed.', 'disposed')]) {
    const w = world(t);
    machine(w, { detected: true, signedIn: true });
    w.host.failWith = null;
    const real = w.host.send;
    w.host.send = async () => {
      throw own;
    };
    await w.service.send('c1', msg('go', UUID(1)), 1);
    w.host.send = real;
    assert.notEqual(head(w).waitingFor, 'hostRefused', own.code);
    assert.equal(w.reports.length, 1, own.code);
  }
});

test('the agent named is the one a held switch sends as, not the chat’s own', async (t) => {
  const w = world(t);
  Object.assign(w.row, {
    name: 'mopilot-mini',
    harnesses: [
      { id: 'claude', detected: true, signedIn: true },
      { id: 'codex', detected: false, signedIn: false, installable: true },
    ],
  });
  w.remote('c1');
  w.kinds.set('c1', 'claude');
  w.switches.set('c1', { harness: 'codex' });
  refuse(w, 'harness_not_configured');
  await w.service.send('c1', msg('go', UUID(1)), 1);
  assert.equal(head(w).error, "Codex isn't installed on mopilot-mini.");
  assert.equal(head(w).refusal.agent, 'codex');
});

test('a mode above the owner’s ceiling: the row says so with the most the machine allows as its action, and carries that mode', async (t) => {
  const w = world(t);
  machine(w, { detected: true, signedIn: true });
  refuse(w, 'policy_refused', 'Default is not allowed on this machine. The most it allows is Read-only.', {
    key: 'permissionMax',
    max: 'read-only',
  });
  await w.service.send('c1', msg('go', UUID(1)), 1);
  assert.equal(head(w).waitingFor, 'hostRefused');
  assert.match(head(w).error, /Ask for approval is not allowed on mopilot-mini/);
  assert.deepEqual(head(w).refusal, {
    code: 'policy_refused',
    action: 'useMode',
    retry: false,
    hostId: 'box',
    machine: 'mopilot-mini',
    agent: 'codex',
    mode: 'read-only',
    named: true,
  });
});

test('an unknown Mac reaches the queue row as a sentence that names the cause, with the Pair again action', async (t) => {
  const w = world(t);
  machine(w, { detected: true, signedIn: true });
  refuse(w, 'unknown_client');
  await w.service.send('c1', msg('go', UUID(7)), 1);
  assert.equal(head(w).error, "mopilot-mini doesn't know this Mac.");
  assert.deepEqual([head(w).refusal.action, head(w).refusal.named, head(w).refusal.own], ['openMachines', true, undefined]);
});

test('a second message behind a refused unknown Mac is one refused row, not two; Retry sends both once, in order, once the Host trusts the Mac', async (t) => {
  const w = world(t);
  machine(w, { detected: true, signedIn: true });
  refuse(w, 'unknown_client');
  await w.service.send('c1', msg('first', UUID(1)), 1);
  await w.service.send('c1', msg('second', UUID(2)), 1);
  const rows = w.queues.get('c1')!;
  assert.deepEqual(
    rows.map((r: any) => [r.text, r.waitingFor ?? null]),
    [
      ['first', 'hostRefused'],
      ['second', null],
    ],
    'only the head carries the refusal; the one behind it waits its turn',
  );
  assert.equal(w.sent.length, 0);
  // the Host trusts this Mac now (the connection asks it again): Retry on the head sends the head, then the one behind it
  w.host.failWith = null;
  assert.deepEqual(await w.service.sendNow('c1', rows[0].id), { status: 'sent' });
  assert.deepEqual(
    w.sent.map((s) => s.item.text),
    ['first', 'second'],
  );
  assert.deepEqual(
    w.queues.get('c1')!.filter((r: any) => r.waitingFor),
    [],
    'nothing waits or is refused any more',
  );
});

test('a locked keychain shows its cause and Retry on the row, as this app’s own refusal', async (t) => {
  const w = world(t);
  machine(w, { detected: true, signedIn: true });
  w.host.failWith = Object.assign(new Error('This app’s Host key cannot be read.'), { code: 'key_unreadable', app: true });
  await w.service.send('c1', msg('go', UUID(8)), 1);
  assert.equal(head(w).error, "This Mac can't read its key for mopilot-mini. Unlock the keychain, then Retry.");
  assert.deepEqual([head(w).refusal.action, head(w).refusal.retry], [null, true]);
});
