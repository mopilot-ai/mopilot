// DEV ONLY: the user's remote machines as the Mac's Host phone facade gives them to the remote service (electron/app/hostPhone.cjs), for `--fake-hosts`: one online machine (an agent ready on its own sign-in, one signed out, one on the user's key), one offline machine, a folder list, a chat started there or moved there, and refusals with the Mac's own codes. Nothing reaches a real machine.
const STUDIO = 'ssh:studio';
const MINI = 'ssh:old-mini';
const HOUR = 3_600_000;
/** What a machine shares, and the folders in it. */
const ROOT = '/Users/dev';
const KNOWN = ['mopilot', 'website', 'notes'];
/** The saved projects on this Mac a chat may be moved back into. */
const PROJECTS = [{ id: 'dev-repo', path: '/Users/dev/mopilot' }];

/** A refusal as main words and codes it (electron/host/machineChatStart.cjs, the Switch host codes). @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./fakeApp.mjs').createFakeApp>} o.app the fake app: a chat started on a machine is one of its chats
 * @param {(line: string) => void} o.log
 * @param {() => number} [o.now]
 * @param {Awaited<ReturnType<typeof import('./realHost.mjs').startRealHost>> | null} [o.real] a real Host the made-up machines are joined by (realHost.mjs), with the Mac's enrollment courier
 */
export function createFakeHosts({ app, log, now = Date.now, real = null }) {
  /** Whether the old mini answers (the `hosts` bench command flips it). */
  let miniOnline = false;
  /** @type {Map<string, string>} chat -> the machine it runs on */
  const owners = new Map();
  const seen = now();
  /** Chats with new files, which a phone may not carry (the second seeded chat). */
  const DIRTY = new Set([...app.chats.keys()].slice(1, 2));

  /** @type {Map<string, 'ready' | 'missing' | 'signin'>} what the bench set for one agent on one machine (`agent`), over the fixture's own rows */
  const states = new Map();
  const LABELS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' };
  const WORDS = {
    ready: '',
    missing: (/** @type {string} */ name) => `Not installed on ${name}`,
    signin: (/** @type {string} */ name) => `Sign in on ${name}`,
  };
  /** An agent row with the bench's state over the fixture's: the reason is the Host's own words for it. */
  const shown = (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ row) => {
    const state = states.get(`${id}/${row.id}`);
    if (!state) return row;
    const reason = state === 'ready' ? '' : WORDS[state](name);
    return { ...row, state, reason };
  };
  /** The machines.cjs rows: their status, agents (with `lent` for one on the user's key) and what Host last said. */
  const rows = () => [
    ...(real ? [real.row()] : []),
    {
      id: STUDIO,
      name: 'studio',
      status: 'online',
      note: 'SSH · Claude Code, Codex, Gemini',
      agents: [
        { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
        { id: 'codex', label: 'Codex', state: 'signin', reason: 'Sign in on studio' },
        { id: 'gemini', label: 'Gemini', state: 'ready', reason: '', lent: true },
      ].map((a) => shown(STUDIO, 'studio', a)),
      installable: [],
      lastSeen: now(),
      localNetwork: 'allowed',
      waitingForLogin: null,
      path: { path: 'relay' },
    },
    {
      id: MINI,
      name: 'old-mini',
      status: miniOnline ? 'online' : 'offline',
      note: miniOnline ? 'SSH · Claude Code' : 'No answer for 90 seconds.',
      agents: [{ id: 'claude', label: 'Claude Code', state: miniOnline ? 'ready' : 'missing', reason: '' }].map((a) =>
        shown(MINI, 'old-mini', a),
      ),
      installable: [],
      lastSeen: miniOnline ? now() : seen - 2 * HOUR,
      localNetwork: miniOnline ? 'allowed' : 'unknown',
      waitingForLogin: null,
    },
  ];
  /** The registry records the facade reads `via` from: Claude Code signed in on studio, Gemini on the user's key. */
  const RECORDS = {
    [STUDIO]: {
      name: 'studio',
      harnesses: [
        { id: 'claude', detected: true, signedIn: true },
        { id: 'codex', detected: true, signedIn: false },
        { id: 'gemini', detected: true, signedIn: false, takesKey: true },
      ],
    },
    [MINI]: { name: 'old-mini', harnesses: [{ id: 'claude', detected: true, signedIn: true }] },
  };
  const recordOf = (/** @type {string} */ id) =>
    real && id === real.id ? real.record() : (RECORDS[/** @type {keyof typeof RECORDS} */ (id)] ?? null);
  const nameOf = (/** @type {string} */ id) => recordOf(id)?.name ?? null;
  const online = (/** @type {string} */ id) => id === STUDIO || (id === MINI && miniOnline) || (real !== null && id === real.id);

  // one chat of the seeds already runs on studio, so the phone shows a machine chip on it
  const [seed] = app.chats.keys();
  if (seed) owners.set(seed, STUDIO);

  return {
    allowed: () => true,
    rows,
    record: recordOf,
    /** The Mac's enrollment courier for a phone's own path to a Host (null without a real Host: the made-up machines have none). */
    phoneDirect: real ? real.direct : null,
    /** The real Host raises a card with no app attached (`run host-card`). @param {string} [text] */
    hostCard(text) {
      if (!real) throw new Error('Start the host with --real-host <vm> to have a Host that raises cards.');
      return real.raise(text);
    },
    /** Waits for one raised card to be answered (`run s3`). @param {string} chatId @param {number} limitMs */
    hostWaitCard(chatId, limitMs) {
      if (!real) throw new Error('Start the host with --real-host <vm> to have a Host that raises cards.');
      return real.waitCardGone(chatId, limitMs);
    },
    /** The real Host starts a chat on one of its agents (`run host-chat`). @param {'fake' | 'claude' | 'codex'} harness @param {string} text */
    async hostChat(harness, text) {
      if (!real) throw new Error('Start the host with --real-host <vm> to have a Host with chats.');
      const chatId = await real.startChat(harness, text);
      // the Mac knows the chat it started: it is in its list, owned by the machine, so a phone lists it under the machine and opens it through the Host
      app.add({ id: chatId, title: text.split('\n')[0].slice(0, 60), harness: harness === 'fake' ? 'acp:fake' : harness, at: now() });
      owners.set(chatId, real.id);
      return chatId;
    },
    /** The real Host's agents, one line (`run host-status`). */
    hostStatus() {
      if (!real) throw new Error('Start the host with --real-host <vm> to have a Host with agents.');
      return real.status();
    },
    /** The app answers the Host's cards (`run host-answer`). @param {'allow' | 'deny'} kind */
    hostAnswer(kind) {
      if (!real) throw new Error('Start the host with --real-host <vm> to have a Host with cards.');
      return real.answerHere(kind);
    },
    /** The owner's switch for one phone: on, it may enroll with the real Host; off, its enrollment is taken away. @param {string} pairId @param {boolean} on */
    async setDirect(pairId, on) {
      if (!real) throw new Error('Start the host with --real-host <vm> to have a Host a phone can enroll with.');
      if (on) real.direct.offer(real.id, pairId);
      else await real.direct.forget(real.id, pairId);
    },
    orgCovers: () => false,
    /**
     * The folders a machine shares, read as the real facade reads them (app/hostPhone.cjs listFolder): a machine not in the list, one that
     * is away (`awayCode`) and a folder outside what it shares or missing are refused with the codes the Mac uses.
     * @param {string} id @param {string} [path] @param {string} [awayCode]
     */
    async folders(id, path, awayCode = 'offline') {
      const name = nameOf(id);
      if (!name) throw refusal('That machine is not in the list.', 'unknown_machine');
      if (!online(id)) throw refusal(`${name} isn't reachable. Check it's online, then try again.`, awayCode);
      const at = path ?? ROOT;
      if (at !== ROOT && !at.startsWith(`${ROOT}/`)) throw refusal(`That folder is outside what ${name} shares.`, 'outside_roots');
      const [, , , first] = at.split('/');
      if (first && !KNOWN.includes(first)) throw refusal(`That folder doesn't exist on ${name}.`, 'directory_missing');
      return {
        path: at,
        roots: [ROOT],
        entries: KNOWN.map((name) => ({ name, path: `${at}/${name}`, git: name !== 'notes' })),
      };
    },
    /**
     * A chat on a machine, refused as the composer is: the machine and its folder first (a machine that is away is refused, not queued),
     * then an agent not installed or signed out there. `check` throws when the phone may no longer act.
     * @param {{ hostId: string, folder: string, harness: string, projectId: string | null, text: string, check: () => void }} q
     */
    async start({ hostId, folder, harness, projectId, text, check }) {
      await this.folders(hostId, folder);
      check();
      const record = /** @type {NonNullable<ReturnType<typeof recordOf>>} */ (recordOf(hostId));
      const agent = harness.startsWith('acp:') ? harness.slice(4) : harness;
      const set = states.get(`${hostId}/${agent}`);
      const there = set === 'missing' ? undefined : record.harnesses.find((h) => h.id === agent);
      if (!there) throw refusal(`${agent} isn't installed on ${record.name}.`, 'harness_not_configured');
      if (set === 'signin' || (set !== 'ready' && !there.signedIn && !(/** @type {any} */ (there).takesKey)))
        throw refusal(`Sign in to ${agent[0].toUpperCase()}${agent.slice(1)} on ${record.name}.`, 'harness_not_configured');
      const { chatId } = await app.ops.start({ harness, text, projectId });
      owners.set(chatId, hostId);
      log(`hosts: ${chatId} started on ${record.name} in ${folder}`);
      return { chatId };
    },
    /**
     * Switch host as the real facade answers it: back to this Mac only into a saved project's folder, a machine's folder read first
     * (`target_offline` when it is away), a chat with new files refused for its changes, a clean chat moved with them.
     * @param {{ chatId: string, hostId: string, folder?: string, projectId?: string, carry: 'code' | 'none', check: () => void }} q
     */
    async move({ chatId, hostId, folder, projectId, carry, check }) {
      if (hostId === 'local') {
        if ((owners.get(chatId) ?? 'local') === 'local') throw refusal('This chat already runs there.', 'same_host');
        // a project by its id (the fake's `dev-repo`) or by its folder, as the real facade takes either
        const project = PROJECTS.find((p) => (projectId === undefined ? p.path === folder : p.id === projectId));
        if (!project)
          throw projectId === undefined
            ? refusal('Pick one of your projects on this Mac.', 'outside_roots')
            : refusal("That project isn't in MoPilot.", 'unknown_project');
        folder = project.path;
      } else await this.folders(hostId, folder, 'target_offline');
      if (carry === 'code' && DIRTY.has(chatId))
        throw refusal('Confirm the new files and commits on your Mac, or move without the changes.', 'carry_unconfirmed');
      check();
      if ((owners.get(chatId) ?? 'local') === hostId) throw refusal('This chat already runs there.', 'same_host');
      owners.set(chatId, hostId);
      log(`hosts: ${chatId} moved to ${nameOf(hostId) ?? 'this Mac'} (${folder})`);
      return { hostId, epoch: 1 };
    },
    hostOf: (/** @type {string} */ chatId) => owners.get(chatId) ?? 'local',
    /**
     * Sets one agent's state on a made-up machine (bench `agent`), so a missing or signed-out agent can be met without a special machine.
     * @param {string} machine its name (`studio`, `old-mini`) @param {string} agent `claude`, `codex` or `gemini` @param {string} state `ready`, `missing` or `signin`
     */
    setAgent(machine, agent, state) {
      const id = [STUDIO, MINI].find((m) => nameOf(m) === machine);
      if (!id) throw new Error(`No made-up machine "${machine}". Try: studio, old-mini.`);
      if (!Object.hasOwn(LABELS, agent)) throw new Error(`No agent "${agent}". Try: ${Object.keys(LABELS).join(', ')}.`);
      if (state !== 'ready' && state !== 'missing' && state !== 'signin') throw new Error('State is ready, missing or signin.');
      states.set(`${id}/${agent}`, state);
      log(`hosts: ${agent} on ${machine} is ${state}`);
    },
    /** The old mini comes online or goes away (bench `hosts`): true when it is online now. */
    toggle() {
      miniOnline = !miniOnline;
      log(`hosts: old-mini ${miniOnline ? 'online' : 'offline'}`);
      return miniOnline;
    },
  };
}
