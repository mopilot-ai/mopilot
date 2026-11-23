// The remote methods on the user's remote machines (phones only, and only for an account with Host): list them, list a machine's folders, install, sign in to or update what a machine row offers, and move a chat to another machine through Switch host. Each runs Host's phone facade (app/hostPhone.cjs); the service has already refused every one for an account without Host.
const { RemoteError, asRefusal } = require('../serviceErrors.cjs');

/** The most folders one machines.folders answer lists, so it fits one frame; `more` says some were left out. */
const MAX_FOLDERS = 200;

/** Host's phone facade, while the gate is open. @param {any} svc */
function hostOf(svc) {
  const host = svc.host();
  if (host?.allowed() !== true) throw new RemoteError('forbidden', "Remote machines aren't available for this account.");
  return host;
}

/** Runs one of Host's operations; a refusal main coded for the window keeps its code and words. @template T @param {() => Promise<T>} fn */
async function refusing(fn) {
  try {
    return await fn();
  } catch (error) {
    throw asRefusal(error);
  }
}

/** The direct-access courier (electron/host/phoneEnroll.cjs), while the flag is on. @param {any} svc */
function directOf(svc) {
  const direct = hostOf(svc).phoneDirect;
  if (!direct) throw new RemoteError('forbidden', "Direct access isn't available.");
  return direct;
}

module.exports = {
  'machines.list': (svc, client) => svc.listMachines(client),
  // the phone's own enrollment with a Host, introduced by this Mac (P2); each step is idempotent on the phone-minted relay hostId
  'machines.enroll': async (svc, client, p) => {
    const direct = directOf(svc);
    const name =
      hostOf(svc)
        .rows()
        .find((/** @type {any} */ r) => r.id === p.hostId)?.name ?? p.hostId;
    const answer = await refusing(() =>
      direct.enroll(
        p.hostId,
        client.pairId,
        { relay: p.relay, appPub: p.appPub, appEphPub: p.appEphPub, edPub: p.edPub, name: p.name },
        name,
      ),
    );
    svc.assertPaired(client);
    void svc.onMachinesChanged();
    return answer;
  },
  'machines.forget': async (svc, client, p) => {
    const removed = await refusing(() => directOf(svc).forget(p.hostId, client.pairId));
    void svc.onMachinesChanged();
    return removed;
  },
  'machines.folders': async (svc, _client, p) => {
    if (p.id === 'local') throw new RemoteError('invalid', 'Pick a project for a chat on this Mac.');
    const host = hostOf(svc);
    const listing = await refusing(() => host.folders(p.id, p.path));
    return {
      path: listing.path,
      roots: listing.roots,
      entries: listing.entries.slice(0, MAX_FOLDERS),
      more: listing.entries.length > MAX_FOLDERS,
    };
  },
  // the machine row's Install, Sign in and Update, for a phone: the same operations (electron/app/hostPhone.cjs `agents`), refused the same way
  'machines.install': (svc, _client, p) => refusing(async () => hostOf(svc).agents.install(p.id, p.harness)),
  'machines.installCancel': (svc, _client, p) => refusing(async () => hostOf(svc).agents.installCancel(p.id, p.harness)),
  'machines.signIn': (svc, _client, p) => refusing(async () => hostOf(svc).agents.signIn(p.id, p.harness)),
  'machines.signInInput': (svc, _client, p) => refusing(() => hostOf(svc).agents.signInInput(p.id, p.harness, p.text)),
  'machines.signInCancel': (svc, _client, p) => refusing(async () => hostOf(svc).agents.signInCancel(p.id, p.harness)),
  'machines.agentStatus': (svc, _client, p) => refusing(async () => hostOf(svc).agents.status(p.id, p.harness)),
  'machines.update': (svc, _client, p) => refusing(() => hostOf(svc).agents.update(p.id)),
  'chat.move': async (svc, client, p) => {
    if (!svc.ops.reachable(p.chatId)) throw new RemoteError('gone', svc.goneText);
    const host = hostOf(svc);
    // the move hands the chat over: a phone the Mac removed meanwhile (while the folder and the plan were read) moves nothing
    const check = () => svc.assertPaired(client);
    check();
    // a saved project's id or a folder, whichever the phone sent (shared/remote/schema.mjs)
    const where = p.projectId === undefined ? { folder: p.folder } : { projectId: p.projectId };
    await refusing(() => host.move({ chatId: p.chatId, hostId: p.hostId, ...where, carry: p.carry, check }));
    return { chatId: p.chatId };
  },
};
