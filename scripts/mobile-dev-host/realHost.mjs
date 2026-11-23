// DEV ONLY: a real Host on a machine (a Tart VM) for the dev host's phone to enroll with. The Host is installed and paired as the acceptance run does it (scripts/host-accept), and the Mac's own enrollment courier (electron/host/phoneEnroll.cjs) is given a paired connection to it, so `machines.enroll` on a real phone is the code that ships; only the Mac around it is this dev host.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { agentsOf as hostAgentsOf } from '../../shared/host/agentReadiness.mjs';

/** The cheapest model at low effort for each agent a run may start a chat on. */
const PICKS = { fake: {}, claude: { model: 'haiku', effort: 'low' }, codex: { model: 'gpt-5.6-luna', effort: 'low' } };

/** This Mac as a Tart VM sees it. */
export const TART_GATEWAY = '192.168.64.1';

/**
 * Why the Host reaches the relay on its own loopback: the Mac's courier refuses a relay address that is `ws://` and not loopback (shared/remote/phoneEnrollSchema.mjs), and the dev relay is plain ws on the LAN.
 * This is the forwarder that makes the address true in the machine. @param {string} node @param {number} port @param {string} to
 */
export const forwarderCommand = (node, port, to) =>
  `( nohup "${node}" -e 'const n=require("net");n.createServer(c=>{const u=n.connect(${port},"${to}");c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy())}).listen(${port},"127.0.0.1")' >/dev/null 2>&1 & echo $! )`;

/**
 * The pieces of the acceptance run this uses (scripts/host-accept*), taken as one object so a test brings stand-ins.
 * @typedef {object} Kit
 * @property {(vm: string) => any} makeCtx a run's context for the machine (its channel, the app's own installer and pairing code, an output folder)
 * @property {Function} runSteps
 * @property {any[]} STEPS
 * @property {(ctx: any) => Promise<{ request: (method: string, params?: object) => Promise<any>, close: () => void }>} session a paired, said-hello connection
 * @property {(ctx: any) => Promise<unknown>} provideFakeAgent
 * @property {(ctx: any) => Promise<unknown>} restart
 * @property {(ctx: any) => Promise<unknown>} hostUp
 * @property {(ctx: any, o?: { restartHost?: boolean }) => Promise<unknown>} removeTestAgent
 * @property {(ctx: any) => Promise<unknown>} cleanup
 */

/**
 * Installs the Host in the machine, pairs, gives it the repo's fake ACP agent and starts the Mac's courier on it.
 * @param {object} o
 * @param {string} o.vm the Tart VM's name (`mopilot-*`)
 * @param {string} o.dir the dev host's scratch folder (the courier keeps its ids there)
 * @param {(text: string) => void} o.log
 * @param {Kit} o.kit
 * @param {(o: { file: string, paired: (machineId: string) => Promise<{ call: (m: string, p?: object) => Promise<any>, close: () => void }>, allowed: () => boolean }) => any} o.createPhoneEnroll
 * @param {number} o.relayPort the dev host's relay port: the Host reaches it as ws://127.0.0.1:<port>, through a forwarder in the machine to `gateway`
 * @param {string} [o.gateway] the address of this Mac as the machine sees it (a Tart VM: 192.168.64.1)
 * @param {() => number} [o.now]
 * @param {number} [o.readyMs] how long the row waits for the Host to report a ready agent (default 30 s)
 * @param {(ms: number) => Promise<unknown>} [o.wait]
 */
export async function startRealHost({
  vm,
  dir,
  log,
  kit,
  createPhoneEnroll,
  relayPort,
  gateway = TART_GATEWAY,
  now = Date.now,
  readyMs = 30_000,
  wait = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const ctx = kit.makeCtx(vm);
  // the steps the acceptance run starts every real-machine check with: the machine can run it, the tarball, the install with the app's installer, and the pairing
  const rows = await kit.runSteps({ steps: kit.STEPS, ctx, only: ['A5'] });
  for (const row of rows) log(`host: ${row.id} ${row.status} ${row.title}${row.status === 'FAIL' ? `: ${row.detail}` : ''}`);
  const failed = rows.find((r) => r.status === 'FAIL');
  if (failed) throw new Error(`The Host could not be set up on ${vm}: ${failed.id} ${failed.title}: ${failed.detail}`);
  await kit.provideFakeAgent(ctx);
  // the test agent is signed in on the Host, as the Host lane's own specs set it up: an agent the phone's picker does not know is then a real case
  await ctx.m.run(`cat > "${ctx.state.dataDir}/signed-in.json"`, Buffer.from(JSON.stringify({ fake: true })));
  await kit.restart(ctx);
  await kit.hostUp(ctx);
  const forwarder = await ctx.m.run(forwarderCommand(ctx.state.nodePath, relayPort, gateway));
  const forwarderPid = forwarder.stdout.trim();
  if (forwarder.code !== 0 || !/^\d+$/.test(forwarderPid))
    throw new Error(`The relay forwarder did not start in ${vm}: ${forwarder.stderr.trim() || forwarder.stdout.trim()}`);
  const id = `ssh:${vm}`;
  let online = true;
  let raised = 0;
  const direct = createPhoneEnroll({
    file: path.join(dir, 'host-phone-direct.json'),
    allowed: () => true,
    paired: async (machineId) => {
      if (machineId !== id) throw new Error(`${machineId} is not the Host in ${vm}.`);
      const c = await kit.session(ctx);
      return { call: (method, params) => c.request(method, params), close: () => c.close() };
    },
  });
  /** The Host's own agents, as the Mac's row names them: ready (installed, signed in), sign in, or missing. */
  const agentsOf = async () => {
    const c = await kit.session(ctx);
    try {
      const status = await c.request('status');
      // the test agent is part of the run's own setup: signed out, it is not an agent the machine needs a login for. The rows are the Mac's own (shared agentsOf), so
      // what the Host reports of an agent (`using`, `sources`, `logins`, `models`) reaches the phone as it does through a real Mac
      return hostAgentsOf(
        (status.harnesses ?? []).filter((/** @type {{ id: string, signedIn: boolean }} */ h) => h.id !== 'fake' || h.signedIn),
        vm,
      );
    } finally {
      c.close();
    }
  };
  // a Host that has just started has not finished looking for its agents: the row waits for the first ready one (up to `readyMs`), so it does not say "no agent ready" for good
  let agents = await agentsOf();
  for (let waited = 0; !agents.some((/** @type {{ state: string }} */ a) => a.state === 'ready') && waited < readyMs; waited += 2000) {
    await wait(2000);
    agents = await agentsOf();
  }
  log(`host: ${vm} runs a real Host (${id}); the phone enrolls with it through the Mac's own courier`);
  return {
    id,
    name: vm,
    direct,
    /** The relay address the Host in the machine uses (the phone's own LAN address cannot pass the courier). */
    relayUrl: `ws://127.0.0.1:${relayPort}/v1/ws`,
    /** The machines.cjs row of this machine. */
    row: () => ({
      id,
      name: vm,
      status: online ? 'online' : 'offline',
      note: `SSH · ${
        agents
          .filter((a) => a.state === 'ready')
          .map((a) => a.label)
          .join(', ') || 'no agent ready'
      }`,
      agents,
      installable: [],
      lastSeen: now(),
      localNetwork: 'allowed',
      waitingForLogin: null,
    }),
    /** The registry record the facade reads `via` from. */
    record: () => ({
      name: vm,
      harnesses: agents.map((a) => ({ id: a.id, detected: a.state !== 'missing', signedIn: a.state === 'ready' })),
    }),
    /** Reads the Host's agents again (a login on the machine changes them). */
    async refreshAgents() {
      agents = await agentsOf();
    },
    /** The machine goes away or comes back, as far as the Mac's list says. */
    setOnline(/** @type {boolean} */ on) {
      online = on;
    },
    /**
     * The app asks the Host for a turn that raises a card (the fake agent's `PERMIT`), then drops its own connection: only a phone can answer.
     * @param {string} [text] what the turn is asked (it must contain PERMIT to raise a card)
     */
    async raise(text = 'PERMIT it') {
      const c = await kit.session(ctx);
      try {
        const chatId = `acp:fake:card${(raised += 1)}${randomUUID().slice(0, 8).replaceAll('-', '')}`;
        await c.request('chat.subscribe', { chatId, epoch: 1, fromRev: 0 });
        await c.request('chat.start', { chatId, epoch: 1, key: `dev-${chatId}`, harness: 'acp:fake', text, cwd: ctx.state.dataDir });
        return chatId;
      } finally {
        c.close();
      }
    },
    /**
     * The app starts a chat on one of the Host's own agents (the cheapest model, low effort) and drops its connection: the phone then reads and drives it.
     * @param {'fake' | 'claude' | 'codex'} harness @param {string} text
     */
    async startChat(harness, text) {
      const c = await kit.session(ctx);
      try {
        const chatId =
          harness === 'fake'
            ? `acp:fake:chat${(raised += 1)}${randomUUID().slice(0, 8).replaceAll('-', '')}`
            : harness === 'claude'
              ? `claude:${randomUUID()}`
              : randomUUID();
        const picked = PICKS[harness];
        await c.request('chat.subscribe', { chatId, epoch: 1, fromRev: 0 });
        await c.request('chat.start', {
          chatId,
          epoch: 1,
          key: `dev-${chatId}`,
          harness: harness === 'fake' ? 'acp:fake' : harness,
          text,
          cwd: ctx.state.dataDir,
          ...picked,
        });
        return chatId;
      } finally {
        c.close();
      }
    },
    /** What the Host says of itself, one line: its agents as the acceptance run prints them (installed or absent, signed in or out). */
    async status() {
      const c = await kit.session(ctx);
      try {
        const s = await c.request('status');
        return (s.harnesses ?? [])
          .map(
            (/** @type {{ id: string, detected: boolean, signedIn: boolean }} */ h) =>
              `${h.id}:${h.detected ? 'installed' : 'absent'}/${h.signedIn ? 'in' : 'out'}`,
          )
          .join(' ');
      } finally {
        c.close();
      }
    },
    /**
     * The app answers every card the Host waits on, as another client would (a phone's card turns to "Answered elsewhere").
     * @param {'allow' | 'deny'} kind @returns {Promise<number>} how many cards it answered
     */
    async answerHere(kind) {
      const c = await kit.session(ctx);
      try {
        const { cards = [] } = await c.request('host.pending');
        for (const card of cards) {
          const option = card.options.find((/** @type {{ kind: string }} */ o) => o.kind === kind) ?? card.options[0];
          await c.request('chat.answer', {
            chatId: card.chatId,
            epoch: card.epoch,
            requestId: card.requestId,
            optionId: option.optionId,
            key: `dev-answer-${card.requestId}`,
          });
        }
        return cards.length;
      } finally {
        c.close();
      }
    },
    /**
     * Waits until the Host no longer holds a card for a chat (someone answered it), polling its pending list.
     * @param {string} chatId @param {number} [limitMs] @returns {Promise<{ gone: boolean, ms: number }>}
     */
    async waitCardGone(chatId, limitMs = 120_000) {
      const started = now();
      // one session for the whole wait: opening one per poll would delay the answer's time by the open
      const c = await kit.session(ctx);
      try {
        for (;;) {
          const { cards = [] } = await c.request('host.pending');
          const at = now() - started;
          if (!cards.some((/** @type {{ chatId: string }} */ card) => card.chatId === chatId)) return { gone: true, ms: at };
          if (at > limitMs) return { gone: false, ms: at };
          await wait(500);
        }
      } finally {
        c.close();
      }
    },
    /** Takes the run's test agent off; the Host is uninstalled too unless `keep`. */
    async stop({ keep = false } = {}) {
      await ctx.m.run(`kill ${forwarderPid} 2>/dev/null; true`);
      if (keep) await kit.removeTestAgent(ctx, { restartHost: true });
      else await kit.cleanup(ctx);
    },
  };
}
