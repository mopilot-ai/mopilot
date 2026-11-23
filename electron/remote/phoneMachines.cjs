// The user's remote machines as a phone sees them (machines.list, machines.changed): this Mac first as id 'local', then each machine's row (electron/host/machines.cjs) with the Mac's own status words (shared/host/machineLine.mjs), and which Host a chat runs on. Only while Host's gate is open; no key, lease or sign-in detail ever leaves here.
const { machineLine, shownAgents } = require('../../shared/host/machineLine.mjs');
const { machineModels } = require('../../shared/host/models.mjs');
const { cleanComputerName } = require('../../shared/remote/computerName.mjs');

/** The methods only an account with Host may call. */
const HOST_METHODS = [
  'machines.list',
  'machines.folders',
  'chat.move',
  'machines.enroll',
  'machines.forget',
  // what a machine's row offers for a missing or signed-out agent and an old Host, run for a phone
  'machines.install',
  'machines.installCancel',
  'machines.signIn',
  'machines.signInInput',
  'machines.signInCancel',
  'machines.agentStatus',
  'machines.update',
];
/** This Mac's id among the machines, as the ownership file names it (electron/host/ownership.cjs LOCAL_HOST_ID). */
const LOCAL = 'local';
/** A machine's status as the phone names it: the Mac's 'attention' is a machine that needs setting up. */
const STATUS = { online: 'online', offline: 'offline', attention: 'needs-setup' };
const NETWORK = new Set(['allowed', 'denied']);

/**
 * How a ready agent runs there: signed in on the machine itself ('own'), with the organization's lease ('org', lent before a key:
 * electron/host/remoteCredentials.cjs) or with the user's key ('key'); null when it is not ready. Never the key or the lease itself.
 * @param {{ id: string, state: string | null }} agent @param {any} record the machine's registry record @param {(harness: string) => boolean} orgCovers
 */
function viaOf(agent, record, orgCovers) {
  if (agent.state !== 'ready') return null;
  const reported = record?.harnesses?.find((/** @type {any} */ h) => h.id === agent.id);
  // ready without its own sign-in only on what this Mac lends (shared/host/agentReadiness.mjs `lent`), a basic agent's key included
  if (reported?.signedIn === true) return 'own';
  return reported?.takesOrg === true && orgCovers(agent.id) ? 'org' : 'key';
}

/**
 * One machine's row (machines.cjs list) as a phone's.
 * @param {any} row @param {any} record @param {{ now: number, orgCovers: (harness: string) => boolean }} o
 */
function phoneMachine(row, record, { now, orgCovers }) {
  const agents = Array.isArray(row.agents) ? row.agents : [];
  const { dot, text } = machineLine({ ...row, agents, installable: Array.isArray(row.installable) ? row.installable : [] }, now, 'phone');
  return {
    id: String(row.id),
    name: String(row.name),
    status: STATUS[/** @type {keyof typeof STATUS} */ (row.status)] ?? 'needs-setup',
    line: text,
    tone: dot,
    path: row.path?.path === 'relay' ? 'relay' : 'direct',
    lastSeen: Number.isFinite(row.lastSeen) ? row.lastSeen : null,
    localNetwork: NETWORK.has(row.localNetwork) ? row.localNetwork : 'unknown',
    waitingForLogin: row.waitingForLogin === 'restarted' || row.waitingForLogin === 'signed-out' ? row.waitingForLogin : null,
    // the Host does not report it yet (Remote Run's keep-running switch): unknown, never a guess
    keepRunning: null,
    agents: shownAgents(agents).map((/** @type {any} */ a) => ({
      id: String(a.id),
      label: String(a.label),
      state: a.state,
      via: viaOf(a, record, orgCovers),
      // what a chat started now would use, what else exists, and whether the agent can hold several logins (a Host that reports them)
      ...(a.using ? { using: a.using } : {}),
      ...(a.sources ? { sources: a.sources } : {}),
      ...(typeof a.loginsSupported === 'boolean' ? { loginsSupported: a.loginsSupported } : {}),
      // the models the Host reports for it, each with its resolved name (#4935)
      ...(Array.isArray(a.models) && a.models.length ? { models: machineModels(a.models) } : {}),
      // the Host's words for an agent that is not ready ("Sign in on <machine>: <logins>"), kept short
      ...(typeof a.reason === 'string' && a.reason.trim() ? { reason: a.reason.trim().slice(0, 200) } : {}),
    })),
  };
}

/** This Mac as a machine: online, with the harnesses a new chat can use here, each signed in here. @param {any} svc */
async function localMachine(svc) {
  const harnesses = /** @type {{ id: string, label: string }[]} */ (await svc.ops.harnesses());
  const agents = harnesses.map((h) => ({ id: h.id, label: h.label, state: 'ready', via: 'own' }));
  return {
    id: LOCAL,
    name: cleanComputerName(svc.machineName()) ?? 'This Mac',
    status: 'online',
    line: agents.length ? `Online · ${agents.map((a) => a.label).join(', ')}` : 'Online',
    tone: 'ok',
    path: 'direct',
    lastSeen: svc.now(),
    localNetwork: 'unknown',
    waitingForLogin: null,
    keepRunning: null,
    agents,
  };
}

/** This Mac and every machine, as machines.list answers and machines.changed sends; only this Mac while Host's gate is closed. @param {any} svc */
async function machinesOf(svc) {
  const local = await localMachine(svc);
  const host = svc.host();
  if (host?.allowed() !== true) return [local];
  const now = svc.now();
  const orgCovers = (/** @type {string} */ harness) => host.orgCovers(harness) === true;
  return [local, ...host.rows().map((/** @type {any} */ r) => phoneMachine(r, host.record(r.id), { now, orgCovers }))];
}

/**
 * Where this phone stands with each machine's direct access (P2): 'on', 'offered' (the owner switched it on at the Mac), or 'off'. Empty with the
 * flag off. @param {any} svc @param {{ pairId: string }} client @param {any[]} machines
 */
function directOf(svc, client, machines) {
  const host = svc.host();
  if (host?.allowed() !== true || !host.phoneDirect?.enabled()) return {};
  // a machine that was away when the switch went off is told as soon as it shows online again
  for (const m of machines) if (m.id !== LOCAL && m.status === 'online') void host.phoneDirect.retry(m.id);
  return Object.fromEntries(machines.filter((m) => m.id !== LOCAL).map((m) => [m.id, host.phoneDirect.stateOf(m.id, client.pairId)]));
}

/** A phone's direct states as part of what it was last told: nothing while it has none, so a list without them is the signature it always was. @param {Record<string, string>} direct */
const directSignature = (direct) => (Object.keys(direct).length ? JSON.stringify(direct) : '');

/** What a phone shows of the list: an online machine's last answer is not drawn, so a heartbeat alone is no change. @param {any[]} machines */
const machinesSignature = (machines) => JSON.stringify(machines.map((m) => (m.status === 'offline' ? m : { ...m, lastSeen: null })));

/** The machine a chat runs on now, null for this Mac; asked only while Host's gate is open. @param {any} svc @param {string} chatId */
function hostIdOf(svc, chatId) {
  const hostId = svc.host().hostOf(chatId);
  return typeof hostId === 'string' && hostId !== LOCAL ? hostId : null;
}

module.exports = { HOST_METHODS, LOCAL, directOf, directSignature, machinesOf, machinesSignature, hostIdOf, phoneMachine };
