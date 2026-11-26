// A machine's one status line (src/lib/machineStatus.ts): the first matching state gives the dot, the words and at most one action, the same for Claude Code, Codex and ACP agents: offline with when it was last seen, an install or a sign-in under way, the agents that run there, the agents that need sign-in or install, and a short reason otherwise; a test agent is never named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_NETWORK_HINT, MACHINE_STATES, installableAgents, installOffers, machineStatus, seenAgo } from '../src/lib/machineStatus.ts';

type S = 'ready' | 'signin' | 'missing' | null;
const agent = (id: string, label: string, state: S) => ({ id, label, state, reason: '' });
const claude = (s: S) => agent('claude', 'Claude Code', s);
const codex = (s: S) => agent('codex', 'Codex', s);
const gemini = (s: S) => agent('gemini', 'Gemini', s);
const NOW = 10 * 86_400_000;
const machine = (o: object = {}) =>
  ({
    id: 'ssh:m',
    name: 'm',
    status: 'online',
    note: '',
    signin: null,
    capabilities: { iab: false, cu: false },
    agents: [],
    installable: [],
    lastSeen: null,
    localNetwork: 'unknown',
    waitingForLogin: null,
    ...o,
  }) as any;
const ctx = (o: object = {}) => ({ now: NOW, signin: null, installing: undefined, ...o }) as any;
const view = (state: string) =>
  ({ hostId: 'ssh:m', harness: 'gemini', state, codes: [], link: false, url: null, error: 'Gemini said no.' }) as any;

test('seen ago in short words', () => {
  assert.equal(seenAgo(NOW + 5000, NOW), 'just now', 'a clock a little behind is now');
  assert.equal(seenAgo(NOW - 30_000, NOW), 'just now');
  assert.equal(seenAgo(NOW - 5 * 60_000, NOW), '5 min ago');
  assert.equal(seenAgo(NOW - 2 * 3_600_000 - 60_000, NOW), '2 h ago');
  assert.equal(seenAgo(NOW - 3 * 86_400_000, NOW), '3 d ago');
});

test('offline: when it was last seen, with the registry sentence as the tooltip; nothing to do there', () => {
  const agents = [claude('ready')];
  assert.deepEqual(
    machineStatus(machine({ status: 'offline', lastSeen: NOW - 2 * 3_600_000, note: 'No answer for 90 seconds.', agents }), ctx()),
    {
      dot: 'off',
      text: 'Offline · No answer · seen 2 h ago',
      title: 'Check that it’s on and on the same network.',
      check: { label: 'Check again' },
    },
  );
  assert.deepEqual(machineStatus(machine({ status: 'offline' }), ctx()), {
    dot: 'off',
    text: 'Offline',
    title: undefined,
    check: { label: 'Check again' },
  });
});

test('offline says its cause in a few words, with the one thing to do, for what ssh said', () => {
  const line = (note: string, platform?: string) => machineStatus(machine({ status: 'offline', note, platform }), ctx());
  assert.deepEqual(
    [
      line('Unreachable: ssh: connect to host box port 22: Connection refused', 'darwin').text,
      line('Unreachable: ssh: connect to host box port 22: Connection refused', 'darwin').title,
    ],
    ['Offline · Remote Login is off', 'Turn it on: System Settings → General → Sharing → Remote Login.'],
  );
  assert.equal(line('Unreachable: Connection refused', 'linux').text, 'Offline · ssh is off there');
  // the app's own sentence, as the registry holds it with sshd stopped (seen on the Ubuntu lane)
  assert.equal(line('Unreachable: Could not reach the machine over SSH.', 'linux').text, 'Offline · Can’t reach it over ssh');
  assert.match(line('Unreachable: Could not reach the machine over SSH.', 'darwin').title ?? '', /Remote Login is on/);
  // Through a forwarder a stopped sshd is closed, not refused (seen on the Ubuntu lane).
  assert.equal(line('Unreachable: Connection closed by 192.168.64.1 port 2201', 'linux').text, 'Offline · ssh is off there');
  assert.equal(
    line('Unreachable: kex_exchange_identification: read: Connection reset by peer', 'linux').text,
    'Offline · ssh is off there',
  );
  assert.equal(line('Unreachable: ssh: Could not resolve hostname box').text, 'Offline · Can’t find it');
  assert.equal(line('Unreachable: Permission denied (publickey).').text, 'Offline · It didn’t accept this Mac’s key');
  assert.equal(line('Unreachable: Operation timed out').text, 'Offline · No answer');
  assert.equal(line('Unreachable: REMOTE HOST IDENTIFICATION HAS CHANGED!').text, 'Offline · Its identity changed');
  const other = line('Unreachable: something else broke');
  assert.deepEqual(
    [other.text, other.title, other.check?.label],
    ['Offline', 'Unreachable: something else broke', 'Check again'],
    'a failure with no known cause keeps its words as the tooltip',
  );
});

test('online: the agents that run there by name, test agents never', () => {
  const agents = [gemini('missing'), codex('ready'), agent('fake', 'fake', 'ready'), claude('ready')];
  assert.deepEqual(machineStatus(machine({ agents }), ctx()), { dot: 'ok', text: 'Online · Claude Code, Codex' });
  // an ACP agent alone reads the same way
  assert.equal(machineStatus(machine({ agents: [gemini('ready')] }), ctx()).text, 'Online · Gemini');
});

test('one ready and others signed out: the line says what each needs, the row offers the first Sign in (#4931)', () => {
  const line = machineStatus(machine({ agents: [claude('ready'), gemini('signin'), agent('grok', 'Grok', 'signin')] }), ctx());
  assert.equal(line.text, 'Online · Claude Code · Gemini and Grok need sign-in');
  assert.equal(line.dot, 'ok');
  assert.equal(line.action?.kind, 'signin');
  assert.equal(line.action?.agent.id, 'gemini');
});

test('none ready: who needs sign-in, with Sign in for the first; Claude Code, Codex and ACP agents alike', () => {
  const one = machineStatus(machine({ agents: [codex('signin'), claude('missing')], installable: ['claude'] }), ctx());
  assert.equal(one.text, 'Codex needs sign-in');
  assert.equal(one.dot, 'warn');
  assert.deepEqual([one.action?.kind, one.action?.agent.id, one.action?.label], ['signin', 'codex', 'Sign in']);
  const two = machineStatus(machine({ agents: [gemini('signin'), claude('signin')] }), ctx());
  assert.equal(two.text, 'Claude Code and Gemini need sign-in');
  assert.equal(two.action?.agent.id, 'claude');
  const three = machineStatus(machine({ agents: [gemini('signin'), claude('signin'), codex('signin')] }), ctx());
  assert.equal(three.text, 'Claude Code, Codex and Gemini need sign-in');
});

test('nothing installed: Install for an agent the machine can install itself; one it cannot is not offered', () => {
  const both = machine({ agents: [claude('missing'), codex('missing')], installable: ['claude', 'codex'] });
  const line = machineStatus(both, ctx());
  assert.equal(line.text, 'Claude Code and Codex aren’t installed');
  assert.deepEqual([line.action?.kind, line.action?.agent.id, line.action?.label], ['install', 'claude', 'Install Claude Code']);
  assert.equal(machineStatus(machine({ agents: [codex('missing')], installable: ['codex'] }), ctx()).text, 'Codex isn’t installed');
  assert.deepEqual(installableAgents(machine({ agents: [codex('missing')], installable: [] })), [], 'an older Host installs nothing');
});

test('Install an agent lists every missing agent the Host installs, core first; the row line still speaks of core agents only', () => {
  const m = machine({
    agents: [
      gemini('missing'),
      codex('missing'),
      claude('ready'),
      agent('kimi', 'Kimi Code', 'missing'),
      agent('fake', 'Fake', 'missing'),
      agent('goose', 'goose', 'missing'),
    ],
    installable: ['gemini', 'codex', 'kimi', 'fake'],
  });
  assert.deepEqual(
    installOffers(m).map((a) => a.id),
    ['codex', 'gemini', 'kimi'],
    'Codex first, then the Host order; a test agent, an agent the Host cannot install and an installed one are not offered',
  );
  assert.deepEqual(
    installableAgents(m).map((a) => a.id),
    ['codex'],
    'the row line names core agents only',
  );
  assert.equal(machineStatus(m, ctx()).text, 'Online · Claude Code', 'a ready agent keeps the row quiet; the sheet is where the rest are');
  assert.deepEqual(installOffers(machine({ agents: [gemini('missing')], installable: [] })), [], 'an older Host installs nothing');
});

test('an install under way says so; its dot stays green while another agent runs', () => {
  const installing = { hostId: 'ssh:m', harness: 'codex', state: 'running', line: '', error: null, version: null };
  assert.deepEqual(machineStatus(machine({ agents: [claude('ready'), codex('missing')] }), ctx({ installing })), {
    dot: 'ok',
    text: 'Installing Codex…',
  });
  assert.equal(machineStatus(machine({ agents: [codex('missing')] }), ctx({ installing })).dot, 'warn');
});

test('a sign-in under way speaks for itself (its controls are the row’s); one that ended is started again', () => {
  const g = gemini('signin');
  const running = machineStatus(machine({ agents: [g] }), ctx({ signin: { agent: g, view: view('waiting') } }));
  assert.deepEqual(running, { dot: 'warn', text: 'Gemini: Opening the sign-in page…' });
  const expired = machineStatus(machine({ agents: [g] }), ctx({ signin: { agent: g, view: view('expired') } }));
  assert.equal(expired.text, 'Gemini: That code expired');
  assert.equal(expired.action?.label, 'Get a new code');
  const failed = machineStatus(machine({ agents: [g] }), ctx({ signin: { agent: g, view: view('failed') } }));
  // a vendor's failure in plain words, its own sentence only as the tooltip
  assert.deepEqual([failed.text, failed.title], ["Couldn't sign in to Gemini", 'Gemini said no.']);
  assert.deepEqual([failed.action?.kind, failed.action?.label], ['signin', 'Sign in']);
  const cancelled = machineStatus(machine({ agents: [g] }), ctx({ signin: { agent: g, view: view('cancelled') } }));
  assert.deepEqual([cancelled.text, cancelled.action?.label], ['Gemini needs sign-in', 'Sign in']);
  const coded = machineStatus(machine({ agents: [g] }), ctx({ signin: { agent: g, view: { ...view('waiting'), codes: ['ABCD-1234'] } } }));
  assert.equal(coded.text, 'Gemini: Enter this code in the page that opened: ABCD-1234');
});

test('anything else: the registry’s reason in short words with its sentence as the tooltip, else Needs attention', () => {
  assert.deepEqual(machineStatus(machine({ status: 'attention', note: 'Unreachable: ssh: no Host socket at /h' }), ctx()), {
    dot: 'warn',
    text: 'Not set up yet',
    title: 'Unreachable: ssh: no Host socket at /h',
  });
  assert.deepEqual(machineStatus(machine({ note: 'SSH · claude' }), ctx()), {
    dot: 'warn',
    text: 'Needs attention',
    title: 'SSH · claude',
  });
  assert.deepEqual(machineStatus(machine(), ctx()), { dot: 'warn', text: 'Needs attention', title: undefined });
});

test('an offline machine nobody is signed in on says it waits for a sign-in, ahead of when it was seen; online, it never does', () => {
  const note = 'The machine restarted and is waiting for someone to sign in.';
  assert.deepEqual(machineStatus(machine({ status: 'offline', waitingForLogin: 'restarted', lastSeen: NOW - 3_600_000, note }), ctx()), {
    dot: 'warn',
    text: 'Restarted · waiting for sign-in',
    title: note,
  });
  assert.deepEqual(machineStatus(machine({ status: 'offline', waitingForLogin: 'signed-out' }), ctx()), {
    dot: 'warn',
    text: 'Waiting for sign-in',
    title: undefined,
  });
  assert.equal(machineStatus(machine({ status: 'offline', lastSeen: NOW - 60_000 }), ctx()).text, 'Offline · seen 1 min ago');
  // a stale field on a machine that answers again says nothing
  assert.equal(machineStatus(machine({ waitingForLogin: 'restarted', agents: [claude('ready')] }), ctx()).text, 'Online · Claude Code');
});

test('a Host macOS keeps off its local network says so with where to allow it, after an install or sign-in under way and before the agents', () => {
  const denied = { localNetwork: 'denied', agents: [claude('ready')] };
  assert.deepEqual(machineStatus(machine(denied), ctx()), { dot: 'warn', text: 'Can’t reach local network', title: LOCAL_NETWORK_HINT });
  assert.ok(LOCAL_NETWORK_HINT.length <= 80, 'the hint fits one tooltip line');
  const g = gemini('signin');
  assert.equal(
    machineStatus(machine({ ...denied, agents: [g] }), ctx({ signin: { agent: g, view: view('waiting') } })).text.startsWith('Gemini:'),
    true,
    'a sign-in under way keeps its line',
  );
  assert.equal(machineStatus(machine({ ...denied, status: 'offline' }), ctx()).text, 'Offline');
  assert.equal(machineStatus(machine({ localNetwork: 'allowed', agents: [claude('ready')] }), ctx()).text, 'Online · Claude Code');
  assert.equal(machineStatus(machine({ localNetwork: 'unknown', agents: [claude('ready')] }), ctx()).text, 'Online · Claude Code');
});

test('the states are tried in order and the last one matches every machine', () => {
  assert.deepEqual(
    MACHINE_STATES.map((s) => s.id),
    [
      'peer-removed',
      'deleted-at-provider',
      'creating',
      'waking',
      'asleep',
      'stopping',
      'disk-locked',
      'waiting-for-login',
      'offline',
      'reconnecting',
      'installing',
      'signing-in',
      'host-update',
      'local-network',
      'limit-reached',
      'paused',
      'waiting',
      'stops-at-sign-out',
      'push-off',
      'ready',
      'signin',
      'install',
      'attention',
    ],
  );
  assert.equal(MACHINE_STATES.at(-1)?.match(machine(), ctx()), true);
});

test('a Host that updates says so; a failed update keeps its cause as the tooltip, or none when there is none', () => {
  const line = (o: object) => machineStatus(machine({ agents: [claude('ready')], ...o }), ctx());
  assert.equal(line({ hostStale: true }).text, 'Host is out of date');
  assert.deepEqual(line({ hostStale: true }).update, { label: 'Update' });
  assert.equal(line({ update: 'running' }).text, 'Updating Host…');
  assert.equal(line({ update: 'waiting' }).text, 'Updates when idle');
  assert.equal(line({ update: 'waiting', name: 'box' }).title, 'Waiting for box to finish its work.');
  assert.equal(line({ update: 'running' }).title, undefined, 'a first try has no earlier cause');
  assert.equal(
    line({ update: 'running', updateError: 'No route.' }).title,
    'Last try: No route.',
    'a retry still shows why the last one failed',
  );
  const failed = line({ update: 'failed', updateError: 'disk full' });
  assert.deepEqual([failed.text, failed.title, failed.update?.label], ['Update failed', 'disk full', 'Try again']);
  assert.equal(line({ update: 'failed', updateError: '' }).title, undefined);
});

test('#4923: a Host newer than the app says so and offers no Update; one the order of cannot be told says what Update does', () => {
  const line = (o: object) => machineStatus(machine({ agents: [claude('ready')], ...o }), ctx());
  const newer = line({ hostNewer: true });
  assert.equal(newer.text, 'Host is newer · Update MoPilot');
  assert.equal(newer.update, undefined, 'Update would replace a newer Host with this app’s older build');
  const differs = line({ hostStale: true, hostDiffers: true });
  assert.equal(differs.text, 'Host differs from this app');
  assert.deepEqual(differs.update, { label: 'Update' });
  assert.equal(differs.title, 'Update replaces the Host with this app’s build.');
  // an update under way or failed still reads as such
  assert.equal(line({ hostNewer: true, update: 'running' }).text, 'Updating Host…');
});

test('#4912: a machine added by command has no ssh, so its row never offers an Update that can only be refused', () => {
  const line = (o: object) => machineStatus(machine({ id: 'relay:abc', agents: [claude('ready')], ...o }), ctx());
  const old = line({ hostStale: true });
  assert.equal(old.text, 'Host is out of date · Update it on the machine');
  assert.equal(old.update, undefined);
  assert.equal(old.title, 'No ssh from here. Run the update command on the machine.');
  assert.equal(line({ hostStale: true, hostDiffers: true }).text, 'Host differs from this app · Update it on the machine');
  assert.equal(line({ hostNewer: true }).text, 'Host is newer · Update MoPilot');
  // an ssh machine keeps its button
  assert.deepEqual(machineStatus(machine({ id: 'ssh:me@box', agents: [claude('ready')], hostStale: true }), ctx()).update, {
    label: 'Update',
  });
});

test('a machine whose Host removed this Mac (#5747): its note as the line, a warning, and Remove as the one fix, whatever else it says', () => {
  const note = 'Studio removed this Mac. Remove it here, then pair again with a new code if you need it.';
  for (const o of [
    { status: 'attention' },
    { status: 'offline', lastSeen: NOW - 60_000 },
    { update: 'failed', agents: [claude('signin')] },
  ])
    assert.deepEqual(machineStatus(machine({ ...o, note, peerRemoved: true }), ctx()), {
      dot: 'warn',
      text: note,
      remove: { label: 'Remove' },
    });
  assert.equal(machineStatus(machine({ note }), ctx()).remove, undefined);
});
