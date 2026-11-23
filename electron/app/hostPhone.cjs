// What a paired phone may do with the user's remote machines (electron/remote/methods/host.cjs), made by Host's IPC from the same services the windows use: the machine list and each machine's record, its folders, a chat started there the way a scheduled run starts one, Switch host, and which machine a chat runs on. Only while Host's gate is open; it tells the phones when the machines or the gate change.
const fs = require('node:fs');
const path = require('node:path');
const { LOCAL_HOST_ID } = require('../host/ownership.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');

/** The agent a machine's chat start names (electron/host/machineChatStart.cjs): a basic agent by its own id, Claude Code and Codex by their family (shared/harnessKind.mjs). @param {string} harness */
const machineHarness = (harness) => {
  // the schema took only codex, claude or acp:<id> (shared/remote/schema.mjs HARNESS)
  const { family, basic } = /** @type {{ family: string, basic: string | null }} */ (parseKind(harness));
  return basic ?? family;
};

/** A refusal in the words and codes of the Switch host dialog (src/lib/hostSwitch.ts COPY). @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });
/** Why the folder on the target can't take the chat's changes, as the dialog's codes name it. */
const NOT_READY = {
  other_branch: 'carry_other_branch',
  other_repository: 'carry_mismatch',
  no_repository: 'carry_no_repository',
};

/**
 * What Switch host carries for a phone's 'code': the chat's uncommitted changes to tracked files, once the same plan the dialog shows says
 * the folder takes them. A phone sees no plan, so a new file or an unpushed commit (which the dialog asks the user to confirm) is refused,
 * never sent unseen.
 * @param {{ state: string, plan: any } | null} facts the dialog's code plan, null with no switch runner (electron/host/hostContinue.cjs codePlan)
 */
function carryFor(facts) {
  if (!facts) throw refusal("This chat's changes can't be carried from your phone. Switch it on your Mac.", 'unsupported');
  // the chat has no source folder, so the Mac's dialog has nothing to carry from either
  if (facts.state === 'no_source_folder')
    throw refusal('This chat has no folder to carry changes from. Move it without the changes.', 'no_source_folder');
  // nothing to carry (no repository, nothing changed): the Mac's dialog moves the chat without its changes, and so does a phone
  if (!facts.plan) return null;
  const code = NOT_READY[/** @type {keyof typeof NOT_READY} */ (facts.state)];
  if (code) throw refusal("The folder there can't take this chat's changes. Switch it on your Mac.", code);
  if (facts.state !== 'ready') throw refusal('Check the folder on your Mac first, or move without the changes.', 'carry_unconfirmed');
  if (facts.plan.untracked?.length || facts.plan.unpushed > 0)
    throw refusal('Confirm the new files and commits on your Mac, or move without the changes.', 'carry_unconfirmed');
  if (!facts.plan.files) throw refusal('There are no changes to carry.', 'nothing_to_carry');
  return { confirmed: true, untracked: [], unpushed: 0 };
}

/**
 * A folder as two spellings of it compare (#3765): resolved (no trailing separator) and through a symlink when it exists. Case is folded
 * apart, by `fold`, because only some volumes ignore it.
 * @param {string} folder @param {boolean} fold
 */
function comparable(folder, fold) {
  const given = path.resolve(folder);
  let resolved = given;
  try {
    resolved = fs.realpathSync(given);
  } catch (error) {
    // a folder that is gone compares by its resolved spelling; one that can't be read (a bad name, no permission) is no project's
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
      throw refusal('Pick one of your projects on this Mac.', 'outside_roots');
  }
  return fold ? resolved.toLowerCase() : resolved;
}

/**
 * The window's code plan as a phone reads it. The service answers null both with no switch runner and for a chat with no source folder;
 * the window need not tell them apart, a phone does (carryFor words each).
 * @param {{ state: string, plan: any } | null} facts @param {boolean} hasRunner
 */
function phonePlan(facts, hasRunner) {
  if (facts || !hasRunner) return facts;
  return { state: 'no_source_folder', repository: null, branch: null, dirty: 0, plan: null };
}

/**
 * @param {object} o
 * @param {() => boolean} o.allowed Host's gate (electron/host/access.cjs)
 * @param {(cb: (ok: boolean) => void) => unknown} o.watch follows the gate
 * @param {() => { list: () => { machines: any[] }, row: (id: string) => any, hostFor?: (id: string) => any }} o.machines the machines service (electron/host/machines.cjs)
 * @param {() => { list: (id: string, q: { path?: string }) => Promise<any> }} o.folders a machine's folders (electron/host/folders.cjs)
 * @param {{ start: (q: { chatId: string, hostId: string, folder: string, harness: string, projectId: string | null, credential?: { source: string, login?: string } }, o: { background: true }) => Promise<unknown>, newChatId: (harness: string) => string }} o.machineChats a chat started on a machine (electron/host/machineChatStart.cjs)
 * @param {(chatId: string, item: object, gate: Promise<unknown>) => { action?: string, error?: string } | null} o.enqueue its first message kept in the outbox, the machine told in the background; a rejected `gate` leaves it refused
 * @param {(chatId: string, mode: string) => unknown} o.setMode records the chat's permission before its first message, which carries it to the machine
 * @param {(e: object) => void} o.announce tells the windows of the new chat, as a scheduled run's (app/automations.cjs announceRunChat)
 * @param {(req: { chatId: string, targetHostId: string, cwd: string, lostHostConfirmed: boolean, carry: object | null }) => Promise<unknown>} o.move Switch host (app/ipc/host.cjs host:continue)
 * @param {(req: { chatId: string, targetHostId: string, cwd: string }) => Promise<any>} o.plan what carrying the chat's changes there would send (host:codePlan)
 * @param {{ get: (chatId: string) => { hostId: string } }} o.ownership where each chat runs now (machines.cjs hostOwnership)
 * @param {(harness: string) => boolean} o.orgCovers whether the organization's lease covers an agent
 * @param {() => { installAgent: (id: string, harness: string) => any, cancelInstall: (id: string, harness: string) => boolean, installStatus: (id: string, harness: string) => any, signIn: (id: string, harness: string, recoveryKey: string | undefined, openHere: boolean) => any, signInInput: (id: string, harness: string, text: string) => Promise<boolean>, cancelSignIn: (id: string, harness: string) => boolean, signInStatus: (id: string, harness: string) => any, updateHost: (id: string) => Promise<any> }} o.agents what the machine rows' buttons call (electron/host/machines.cjs): install, sign in and update, run for a phone as for a window
 * @param {() => void} o.changed tells the phones the machines or the gate changed
 * @param {() => { id: string, path: string }[]} o.projects the saved projects (a chat moved back to this Mac goes into one of them)
 * @param {boolean} [o.foldCase] whether this Mac's volumes ignore case (macOS and Windows); a spelling differing only in case then matches last
 */
function createHostPhone({
  allowed,
  watch,
  machines,
  folders,
  machineChats,
  enqueue,
  setMode,
  announce,
  move,
  plan,
  ownership,
  orgCovers,
  agents,
  changed,
  projects,
  foldCase = ['darwin', 'win32'].includes(process.platform),
}) {
  /**
   * The machine's row, from the registry with no round trip: refused when it is not listed or is away. `away` is the refusal for a read that fails.
   * @param {string} hostId @param {string} [awayCode]
   */
  function reachable(hostId, awayCode = 'offline') {
    const machine = machines()
      .list()
      .machines.find((/** @type {{ id: string }} */ m) => m.id === hostId);
    if (!machine) throw refusal('That machine is not in the list.', 'unknown_machine');
    const away = () => refusal(`${machine.name} isn't reachable. Check it's online, then try again.`, awayCode);
    if (machine.status === 'offline') throw away();
    return { machine, away };
  }
  /**
   * A folder a phone names on a machine, read through the same bounded listing as machines.folders: one outside what the machine
   * shares, or missing, is refused with the machine's own code (outside_roots, directory_missing) before anything is made.
   * @param {string} hostId @param {string} folder
   */
  /**
   * A machine's folders, read only from a machine that answers: one that is away is refused first with `offline` (or `awayCode`), and a
   * transport or ssh failure (which carries no code, and text with socket paths and host details) is said as the same short refusal.
   * A refusal the machine coded itself (outside_roots, directory_missing) passes as it is.
   * @param {string} hostId @param {string | undefined} path @param {string} [awayCode]
   */
  async function listFolder(hostId, path, awayCode = 'offline') {
    const { away } = reachable(hostId, awayCode);
    try {
      return await folders().list(hostId, path === undefined ? {} : { path });
    } catch (error) {
      // Object() so a thrown null or string has no code, with no branch of its own
      throw typeof Object(error).code === 'string' ? error : away();
    }
  }
  const readable = (/** @type {string} */ hostId, /** @type {string} */ folder, awayCode = 'offline') =>
    listFolder(hostId, folder, awayCode);
  /** A folder on this Mac a phone may name: a saved project's, as a chat a phone starts here goes only into a project. @param {string} folder */
  const projectFolder = (/** @type {string} */ folder) => {
    // the spelling a project was saved with needs no filesystem read; otherwise the same folder by another spelling, and only then by
    // another case (macOS and Windows volumes usually ignore it, so an exact-case match always wins over a folded one)
    const wanted = comparable(folder, false);
    const same = (/** @type {boolean} */ fold) =>
      projects().find((p) => comparable(p.path, fold) === (fold ? wanted.toLowerCase() : wanted));
    const project = projects().find((p) => p.path === folder) ?? same(false) ?? (foldCase ? same(true) : undefined);
    if (!project) throw refusal('Pick one of your projects on this Mac.', 'outside_roots');
    return project.path;
  };
  /** A saved project's folder by its id, so a phone names a project without ever naming a path on this Mac. @param {string} id */
  const savedProject = (id) => {
    const project = projects().find((p) => p.id === id);
    if (!project) throw refusal("That project isn't in MoPilot.", 'unknown_project');
    return project.path;
  };
  watch(() => changed());
  return {
    allowed,
    /** A phone's own enrollment with a Host (electron/host/phoneEnroll.cjs); null while `host.phoneDirect` is off. */
    phoneDirect: /** @type {any} */ (null),
    // Main-only historical image source: the same gated registry connection used by the machine's own actions.
    imageHostFor: (id) => (allowed() ? (machines().hostFor?.(id) ?? null) : null),
    rows: () => machines().list().machines,
    record: (/** @type {string} */ id) => machines().row(id) ?? null,
    orgCovers,
    folders: (/** @type {string} */ id, /** @type {string | undefined} */ path) => listFolder(id, path),
    /**
     * A new chat on a machine with its first message, as a scheduled run makes one (electron/platform/automationRun.cjs runOnMachine):
     * readiness is checked before creation; folder refusals remain visible on the durable queued message.
     * @param {{ hostId: string, folder: string, harness: string, projectId: string | null, text: string, model: string | null, effort: string | null, permission?: string, attachments?: any[], nativeMessageId?: string, credential?: { source: string, login?: string }, check?: () => void }} q
     * `check`: throws when the phone may no longer act, including while the start was being prepared
     */
    async start({
      hostId,
      folder,
      harness,
      projectId,
      text,
      model,
      effort,
      permission,
      attachments = [],
      nativeMessageId,
      credential,
      check = () => undefined,
    }) {
      // the machine's row decides at once (unknown, away); the folder is read after the chat is made, off the reply's path
      reachable(hostId);
      check();
      const agent = machineHarness(harness);
      const chatId = machineChats.newChatId(agent);
      const { listed } = /** @type {{ listed: Promise<void> }} */ (
        await machineChats.start(
          { chatId, hostId, folder, harness: agent, projectId, ...(credential ? { credential } : {}) },
          { background: true },
        )
      );
      check();
      // the chat's mode is what its first message carries to the machine (remoteSend drainChat)
      if (permission !== undefined) setMode(chatId, permission);
      void listed.then(() => announce({ harness: 'acp', chatId, cwd: folder, worktreeOf: null, hostId, projectId }));
      const opts = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
      const item = { text, attachments, opts, ...(nativeMessageId ? { id: nativeMessageId } : {}) };
      // kept in the outbox and told to the machine in the background; a folder the machine refuses leaves the message refused in the chat's queue
      const sent = enqueue(chatId, item, readable(hostId, folder));
      if (!sent || sent.action === 'failed') return { chatId, warning: `Your message didn't start: ${sent?.error ?? 'Host is off'}` };
      return { chatId };
    },
    /**
     * Switch host: to a machine into a folder it shares, or back to this Mac into a saved project, named by its id (resolved here, so an id
     * can only ever be a saved project's folder) or by its folder; `check` as for start.
     * @param {{ chatId: string, hostId: string, folder?: string, projectId?: string, carry: 'code' | 'none', check?: () => void }} q
     */
    async move({ chatId, hostId, projectId, carry, check = () => undefined, folder: named }) {
      let folder = /** @type {string} */ (named);
      if (hostId === LOCAL_HOST_ID) {
        // a chat already on this Mac has nowhere to move, and needs no folder read to be told so
        if (ownership.get(chatId).hostId === LOCAL_HOST_ID) throw refusal('This chat already runs there.', 'same_host');
        if (projectId !== undefined) folder = savedProject(projectId);
        else folder = projectFolder(folder);
      }
      // an away target is `target_offline`, as the Switch host dialog words it, not whatever its folder read would fail with
      else await readable(hostId, folder, 'target_offline');
      const req = { chatId, targetHostId: hostId, cwd: folder };
      const carried = carry === 'code' ? carryFor(await plan(req)) : null;
      check();
      return move({ ...req, lostHostConfirmed: false, carry: carried });
    },
    hostOf: (/** @type {string} */ chatId) => (allowed() ? ownership.get(chatId).hostId : LOCAL_HOST_ID),
    /**
     * What a machine's row offers for an agent that is missing, signed out, or a Host that is old, for a phone: the same operations as the row's
     * buttons (install on the machine, sign in on the machine, update the Host), each refused first for a machine that is not listed or away.
     * A phone's sign-in is not opened on this Mac: the view carries the page and its code, and the phone opens the page in its own browser.
     */
    agents: {
      /** @param {string} hostId @param {string} harness */
      install(hostId, harness) {
        reachable(hostId);
        return agents().installAgent(hostId, harness);
      },
      /** @param {string} hostId @param {string} harness */
      installCancel: (hostId, harness) => ({ cancelled: agents().cancelInstall(hostId, harness) }),
      /** @param {string} hostId @param {string} harness */
      signIn(hostId, harness) {
        reachable(hostId);
        return agents().signIn(hostId, harness, undefined, false);
      },
      /** @param {string} hostId @param {string} harness @param {string} text */
      signInInput: async (hostId, harness, text) => ({ accepted: await agents().signInInput(hostId, harness, text) }),
      /** @param {string} hostId @param {string} harness */
      signInCancel: (hostId, harness) => ({ cancelled: agents().cancelSignIn(hostId, harness) }),
      /** How the install and the sign-in of one agent stand on a machine now (null: none was started), for a phone that follows them. @param {string} hostId @param {string} harness */
      status: (hostId, harness) => ({ install: agents().installStatus(hostId, harness), signIn: agents().signInStatus(hostId, harness) }),
      /** Sends this app's Host build to the machine (over this Mac's ssh); the Host restarts into it once idle. @param {string} hostId */
      update(hostId) {
        reachable(hostId);
        return agents().updateHost(hostId);
      },
    },
  };
}

module.exports = { createHostPhone, phonePlan };
