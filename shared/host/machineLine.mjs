// A machine's status words shared by the Mac's rows (src/lib/machineStatus.ts) and the phone (electron/remote/phoneMachines.cjs): the registry's reason said short, which agents a row names, "seen 2 h ago", and every status state that needs nothing but the machine and the clock, so both read the same line.
import { INSTALL_WORDS } from './installWords.mjs';

/** @typedef {{ id: string, label: string, state?: 'ready' | 'signin' | 'missing' | null, reason?: string }} LineAgent */
/**
 * What a state reads of a machine (the Mac's HostMachineRow fits).
 * `cloud`, `canWake`, `linkDroppedAt`, `limit`, `paused` and `waiting` are what a Host and a provider add (Remote Run, X2): a machine without them reads as it did before.
 * @typedef {{ status: 'online' | 'offline' | 'attention', note: string, agents: LineAgent[], installable: string[], lastSeen: number | null, localNetwork: string, waitingForLogin: 'restarted' | 'signed-out' | 'locked' | null, id?: string, platform?: string, startsAtBoot?: string, cloud?: 'deleted' | 'creating' | 'setting-up' | 'connecting' | 'waking' | 'asleep' | 'stopping' | null, canWake?: boolean, linkDroppedAt?: number | null, limit?: { usd: number } | null, paused?: boolean, waiting?: number, pushSkipped?: number }} LineMachine
 */

/** The short phrase for a registry reason; any other note (an online machine's "SSH · claude, codex") is returned as it is. @param {string} note @param {readonly { id: string, label: string }[]} [agents] */
export function machineReason(note, agents = []) {
  const agentName = (/** @type {string} */ id) => agents.find((a) => a.id === id)?.label ?? id;
  if (/^Unreachable:.*no Host socket/i.test(note)) return 'Not set up yet';
  if (/^Unreachable:/.test(note) || note === 'No answer for 90 seconds.') return "Can't reach this machine";
  if (note === 'Not reached yet.') return 'Not reached yet';
  if (note === 'The machine restarted and is waiting for someone to sign in.') return 'Restarted · waiting for sign-in';
  if (note === 'The machine is waiting for someone to sign in.') return 'Waiting for sign-in';
  if (note === 'No agent is installed on this machine.') return 'No agent installed';
  const signedOut = /^(\S+) is not signed in on this machine\.$/.exec(note);
  if (signedOut) return `${agentName(signedOut[1])} needs sign-in`;
  const missing = /^(\S+) is not installed on this machine\.$/.exec(note);
  if (missing) return `${agentName(missing[1])} isn't installed`;
  return note;
}

/**
 * What an ssh failure on a machine says, in a few words and the one thing to do about it ('' for a failure that names no cause): the words of the Add card (installFailure.mjs) for the same ssh text.
 * @param {string} note the registry's note for an offline machine @param {string | undefined} platform what the machine's Host last said it runs on
 * @returns {{ cause: string, hint: string }}
 */
export function offlineCause(note, platform) {
  // ssh answers and the Host does not (registry.cjs, signinWait.cjs): the cure is starting it
  if (note === 'The machine answers over ssh, but its Host does not.')
    return { cause: 'Its Host isn’t running', hint: 'ssh works: start the Host on it.' };
  if (/host key changed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(note))
    return {
      cause: 'Its identity changed',
      hint: 'If you reinstalled it, remove its old key (ssh-keygen -R <its address>) and add it again. Otherwise don’t connect.',
    };
  if (/Connection refused|Connection closed by|kex_exchange_identification|Connection reset/i.test(note))
    return platform === 'darwin'
      ? { cause: 'Remote Login is off', hint: 'Turn it on: System Settings → General → Sharing → Remote Login.' }
      : { cause: 'ssh is off there', hint: 'Start sshd on it.' };
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(note))
    return { cause: 'Can’t find it', hint: 'Check its name, or that both are on the same network.' };
  if (/Permission denied|Too many authentication failures/i.test(note))
    return { cause: 'It didn’t accept this Mac’s key', hint: 'Add the machine again to set up its sign-in.' };
  if (/timed out|No route to host|Network is unreachable|Host is down|^No answer/i.test(note))
    return { cause: 'No answer', hint: 'Check that it’s on and on the same network.' };
  // the app's own sentence when the tunnel never came up and ssh said nothing more (seen on the Ubuntu lane with sshd stopped)
  if (/Could not reach the machine/i.test(note))
    return {
      cause: 'Can’t reach it over ssh',
      hint:
        platform === 'darwin'
          ? 'Check that it’s on, on the same network, and that Remote Login is on.'
          : 'Check that it’s on, on the same network, and that sshd is running.',
    };
  return { cause: '', hint: '' };
}

/** The agents every user is shown on every machine, installed or not: a missing one reads "not installed", never as absent. */
export const CORE_AGENTS = /** @type {readonly string[]} */ (['claude', 'codex']);
/** Agents only tests register on a machine (the fake ACP agent): never shown, never offered. */
const TEST_AGENTS = ['fake'];

/** Core agents first, then the rest in the Host's order. @param {LineAgent} a @param {LineAgent} b */
const coreFirst = (a, b) =>
  (CORE_AGENTS.includes(a.id) ? CORE_AGENTS.indexOf(a.id) : CORE_AGENTS.length) -
  (CORE_AGENTS.includes(b.id) ? CORE_AGENTS.indexOf(b.id) : CORE_AGENTS.length);

/** The agents the row shows: every installed one, and a core agent that is missing. An agent the machine lacks and the user never runs is left out, and so is a test agent. @template {LineAgent} T @param {readonly T[]} agents @returns {T[]} */
export function shownAgents(agents) {
  return agents
    .filter((a) => !TEST_AGENTS.includes(a.id))
    .filter((a) => a.state === 'ready' || a.state === 'signin' || (a.state === 'missing' && CORE_AGENTS.includes(a.id)))
    .sort(coreFirst);
}

/**
 * The agents the machine's menu lists: `shownAgents`, plus the agent the chat or the new chat wants when the machine lacks it (the Host reports it `detected:false`, or does not name it at all), so the menu names what the chat cannot run instead of staying silent. A test agent is never added.
 * @template {LineAgent} T @param {readonly T[]} agents @param {{ id: string, label: string } | null | undefined} wanted @returns {T[]}
 */
export function shownWithWanted(agents, wanted) {
  const shown = shownAgents(agents);
  // a machine that has reported no agent yet (an older Host, or one not answered) says nothing about this one: the menu waits for it
  if (!wanted || !agents.length || TEST_AGENTS.includes(wanted.id) || shown.some((a) => a.id === wanted.id)) return shown;
  const reported = agents.find((a) => a.id === wanted.id);
  return [...shown, /** @type {T} */ (reported ?? { id: wanted.id, label: wanted.label, state: 'missing', reason: '' })];
}

/** The installed agents still signed out on the machine, core agents first. @template {LineAgent} T @param {readonly T[]} agents @returns {T[]} */
export const signinAgents = (agents) => shownAgents(agents).filter((a) => a.state === 'signin');

/** The core agents the machine lacks. @template {LineAgent} T @param {readonly T[]} agents @returns {T[]} */
export const missingAgents = (agents) => shownAgents(agents).filter((a) => a.state === 'missing');

/** The missing agents the row can offer to install: only those the machine's Host says it can install. @template {LineAgent} T @param {{ agents: readonly T[], installable: readonly string[] }} m @returns {T[]} */
export const installableAgents = (m) => missingAgents(m.agents).filter((a) => m.installable.includes(a.id));

/** Every agent the machine lacks and its Host can install (a vendor npm package into the Host's own folder, no sudo): Claude Code and Codex first, then the rest in the Host's order. The row's Install an agent… sheet lists these; the row's one line still speaks of core agents only. @template {LineAgent} T @param {{ agents: readonly T[], installable: readonly string[] }} m @returns {T[]} */
export const installOffers = (m) =>
  m.agents.filter((a) => a.state === 'missing' && m.installable.includes(a.id) && !TEST_AGENTS.includes(a.id)).sort(coreFirst);

/** "just now", "5 min ago", "2 h ago", "3 d ago". @param {number} at @param {number} now */
export function seenAgo(at, now) {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

/** "A", "A and B", "A, B and C" (never called with none). @param {readonly string[]} list */
const names = (list) => (list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** The names a Mac's line says: the first two, then "+N" ("Gemini, Grok +2"); the phone keeps every name. @param {readonly string[]} list @param {LineContext} c */
const said = (list, c) => (c.client === 'phone' || list.length <= 3 ? names(list) : `${list.slice(0, 2).join(', ')} +${list.length - 2}`);

/** @param {LineMachine} m */
const ready = (m) => shownAgents(m.agents).filter((a) => a.state === 'ready');

/** An installed agent that needs a sign-in: a read still under way ("Checking on box…") is not yet a need. The row words, the row's menu and the picker all ask this. @param {LineAgent} a */
export const needsSignin = (a) => a.state === 'signin' && !/^Checking/.test(a.reason ?? '');

/** @param {LineMachine} m */
const needSignin = (m) => signinAgents(m.agents).filter(needsSignin);

/** @param {LineMachine} m @param {LineContext} c */
const signinOf = (m, c) => (c.client === 'phone' ? signinAgents(m.agents) : needSignin(m));

/** Where a machine's Host is allowed onto the local network: the alert macOS shows on it, or the setting it leaves behind. */
export const LOCAL_NETWORK_HINT = 'Allow “node” in the macOS alert or in Privacy & Security › Local Network';

/** What a Mac that waits for a sign-in after a restart can do about it, once it answers again. */
export const KEEP_RUNNING_HINT = 'Once it’s back, turn on Keep running after restart in its ⋯ menu.';
/** What a machine says when cards waited on it and no phone was linked to push them to. */
export const PUSH_OFF_HINT =
  'A card waited on this machine and no phone was linked to it, so nothing was pushed. Open the machine on your phone and choose Reconnect.';
/** What keeps a Linux machine's Host running with nobody signed in. */
export const LINGER_HINT = 'To fix, run on the machine: sudo loginctl enable-linger $USER';

/**
 * @typedef {{ dot: 'ok' | 'warn' | 'off', text: string, title?: string, action?: { kind: 'signin' | 'install', agent: LineAgent, label: string } | { kind: 'cancel' | 'remove' | 'wake' | 'raise-limit', label: string } }} Line
 * @typedef {{ now: number, client?: 'mac' | 'phone' }} LineContext
 * @typedef {{ id: string, match: (m: LineMachine, c: LineContext) => boolean, line: (m: LineMachine, c: LineContext) => Line }} State
 */

/** A link that dropped less than this long ago is "Reconnecting…", not offline. */
export const RECONNECT_MS = 90_000;

/** What a cloud machine's own state says (orders 1 to 6 of the machine line): it comes before anything the Host could report. @type {readonly State[]} */
const CLOUD_STATES = [
  {
    id: 'deleted-at-provider',
    match: (m) => m.cloud === 'deleted',
    line: () => ({ dot: 'off', text: 'Deleted at the provider', action: { kind: 'remove', label: 'Remove' } }),
  },
  {
    id: 'creating',
    match: (m) => m.cloud === 'creating' || m.cloud === 'setting-up' || m.cloud === 'connecting',
    line: (m) => ({
      dot: 'warn',
      text: m.cloud === 'creating' ? 'Creating…' : m.cloud === 'setting-up' ? 'Setting up…' : 'Connecting…',
      action: { kind: 'cancel', label: 'Cancel' },
    }),
  },
  { id: 'waking', match: (m) => m.cloud === 'waking', line: () => ({ dot: 'warn', text: 'Waking…' }) },
  {
    // a client that can reach the provider wakes it; the phone without the provider's key is told where to do it
    id: 'asleep',
    match: (m) => m.cloud === 'asleep',
    line: (m) =>
      m.canWake
        ? { dot: 'off', text: 'Asleep · wakes on next message', action: { kind: 'wake', label: 'Wake' } }
        : { dot: 'off', text: 'Asleep · wake it from your Mac' },
  },
  { id: 'stopping', match: (m) => m.cloud === 'stopping', line: () => ({ dot: 'warn', text: 'Stopping · idle' }) },
];

/** "$20", "$4.20". @param {number} usd */
export const usdText = (usd) => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;

/** The states before an install or a sign-in under way (which only the Mac's window knows): a machine that does not answer. @type {readonly State[]} */
export const LEAD_STATES = [
  ...CLOUD_STATES,
  {
    // FileVault keeps the disk locked after a restart: nothing on the machine starts until someone unlocks it there
    id: 'disk-locked',
    match: (m) => m.status === 'offline' && m.waitingForLogin === 'locked',
    line: (m) => ({ dot: 'warn', text: 'Restarted · disk locked', title: m.note || undefined }),
  },
  {
    // the Host is a login service: after a restart it starts once someone signs in at the machine
    id: 'waiting-for-login',
    match: (m) => m.status === 'offline' && m.waitingForLogin !== null,
    line: (m) => ({
      dot: 'warn',
      text: m.waitingForLogin === 'restarted' ? 'Restarted · waiting for sign-in' : 'Waiting for sign-in',
      title: m.platform === 'darwin' && m.id?.startsWith('ssh:') ? KEEP_RUNNING_HINT : m.note || undefined,
    }),
  },
  {
    id: 'offline',
    match: (m) => m.status === 'offline',
    line: (m, c) => {
      const { cause, hint } = offlineCause(m.note, m.platform);
      return {
        dot: 'off',
        text: ['Offline', cause, m.lastSeen ? `seen ${seenAgo(m.lastSeen, c.now)}` : ''].filter(Boolean).join(' · '),
        title: hint || m.note || undefined,
        check: { label: 'Check again' },
      };
    },
  },
  {
    // the link dropped a moment ago: the registry has not called the machine offline yet
    id: 'reconnecting',
    match: (m, c) => typeof m.linkDroppedAt === 'number' && c.now - m.linkDroppedAt < RECONNECT_MS,
    line: () => ({ dot: 'warn', text: 'Reconnecting…' }),
  },
];

/** The states after an install or a sign-in under way, in order; the last one always matches. @type {readonly State[]} */
export const TAIL_STATES = [
  {
    // the machine still runs chats; what it cannot do is reach devices and servers on its own network
    id: 'local-network',
    match: (m) => m.localNetwork === 'denied',
    line: () => ({ dot: 'warn', text: 'Can’t reach local network', title: LOCAL_NETWORK_HINT }),
  },
  {
    id: 'limit-reached',
    match: (m) => !!m.limit,
    line: (m, c) => ({
      dot: 'warn',
      text: `Limit reached · about ${usdText(/** @type {{ usd: number }} */ (m.limit).usd)} today`,
      ...(c.client !== 'phone' ? { action: { kind: 'raise-limit', label: 'Raise limit' } } : {}),
    }),
  },
  { id: 'paused', match: (m) => m.paused === true, line: () => ({ dot: 'warn', text: 'Paused · no answer' }) },
  { id: 'waiting', match: (m) => (m.waiting ?? 0) > 0, line: (m) => ({ dot: 'warn', text: `${m.waiting} waiting` }) },
  {
    // Linux: a user service whose user does not linger stops at sign-out and after a restart waits for a sign-in; it takes the place of
    // Online only, so a sign-in or install the machine still needs keeps its line and button
    id: 'stops-at-sign-out',
    match: (m) => m.platform === 'linux' && m.startsAtBoot === 'no' && ready(m).length > 0,
    line: () => ({ dot: 'warn', text: 'Stops when you sign out', title: LINGER_HINT }),
  },
  {
    // a Host that raised waiting cards with no phone linked to it lost its relay link: nothing it has to say reaches a phone until it is linked again
    id: 'push-off',
    match: (m) => (m.pushSkipped ?? 0) > 0 && ready(m).length > 0,
    line: () => ({ dot: 'warn', text: 'No phone linked · push is off', title: PUSH_OFF_HINT }),
  },
  {
    id: 'ready',
    match: (m) => ready(m).length > 0,
    // what runs there first, then each installed agent that does not yet (#4931), with Sign in for the first
    line: (m, c) => {
      const out = needSignin(m);
      const text = `Online · ${ready(m)
        .map((a) => a.label)
        .join(', ')}`;
      // the phone's row keeps its words until the phone decides (a device check): only the Mac says it
      if (!out.length || c.client === 'phone') return { dot: 'ok', text };
      return {
        dot: 'ok',
        text: `${text} · ${said(
          out.map((a) => a.label),
          c,
        )} ${out.length > 1 ? 'need' : 'needs'} sign-in`,
        action: { kind: 'signin', agent: out[0], label: 'Sign in' },
      };
    },
  },
  {
    id: 'signin',
    // a read still under way ("Checking…") is no need on the Mac, as in the ready line, the row's menu and the picker; the phone keeps counting every signed-out agent
    match: (m, c) => signinOf(m, c).length > 0,
    line: (m, c) => {
      const out = signinOf(m, c);
      return {
        dot: 'warn',
        text: `${said(
          out.map((a) => a.label),
          c,
        )} ${out.length > 1 ? 'need' : 'needs'} sign-in`,
        action: { kind: 'signin', agent: out[0], label: 'Sign in' },
      };
    },
  },
  {
    id: 'install',
    match: (m) => installableAgents(m).length > 0,
    line: (m) => {
      const missing = installableAgents(m);
      return {
        dot: 'warn',
        text: `${names(missing.map((a) => a.label))} ${missing.length > 1 ? 'aren’t' : 'isn’t'} installed`,
        action: { kind: 'install', agent: missing[0], label: INSTALL_WORDS.install(missing[0].label) },
      };
    },
  },
  {
    id: 'attention',
    match: () => true,
    line: (m) => {
      const short = machineReason(m.note, m.agents);
      // a reason the registry words as a developer sentence is said short; any other note ("SSH · claude") is not a status
      return short === m.note
        ? { dot: 'warn', text: 'Needs attention', title: m.note || undefined }
        : { dot: 'warn', text: short, title: m.note };
    },
  },
];

/** The line of a machine with nothing under way on it (no install, no sign-in): what a phone shows. @param {LineMachine} m @param {number} now @param {'mac' | 'phone'} [client] */
export function machineLine(m, now, client) {
  const c = { now, client };
  const state = /** @type {State} */ ([...LEAD_STATES, ...TAIL_STATES].find((s) => s.match(m, c)));
  const { dot, text } = state.line(m, c);
  return { dot, text };
}
