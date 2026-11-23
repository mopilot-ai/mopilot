// Adapts durable repair jobs to fresh native chats, pinned worktrees and guarded automatic input on every harness.
const path = require('node:path');
const { git: runGit } = require('../platform/gitRun.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { familyOf } = require('../session/contract/route.cjs');
const { WORKER_LEASE_MS } = require('../../shared/mainRepairClaim.mjs');
const { clock } = require('../platform/ports/clock.cjs');
const { isUserTurn, turnHasPerson } = require('../session/userTurn.cjs');
const { isMomoMeta } = require('../../shared/momoChat.mjs');
const { authoredInput } = require('../session/authoredInput.cjs');
const { guardInput, guardInputReady, guardSend } = require('../session/contract/inputGuard.cjs');
const { addGuard } = require('../session/hookChain.cjs');
const { githubRepo } = require('../../shared/mainRepairRepository.mjs');
const { saveMeta } = require('../../shared/metaSave.mjs');
const START = {
  codex: (s, cwd, root, _basic, options) => s.startCodex(cwd, root, options),
  claude: (s, cwd, root, _basic, options) => s.startClaude(cwd, root, options),
  acp: (s, cwd, root, basic, options) => s.startAcp(basic, cwd, root, options),
};
function createRepairRuntime({ live, git = runGit, broadcast }) {
  const controller = live.controller,
    dispatches = new Map();
  const command = async (args, cwd) => {
    const r = await git(args, cwd, 60_000);
    if (!r.ok) throw new Error('Could not verify the repair repository or prepare its worktree');
    return r.stdout.trim();
  };
  const notRepair = (id) => {
    if (live.chats.records.get(id)?.meta?.mainRepair) throw new Error('A repair worker cannot delegate or configure another repair');
  };
  const ownsTurn = (job) => {
    const active = controller.state.get(job.chatId).activeTurn;
    return (
      !!active &&
      !turnHasPerson(active) &&
      ((!!job.ownedInputId && controller.rt(job.chatId).inputToken === `pending-${job.ownedInputId}`) ||
        (!!job.turnId && active.id === job.turnId))
    );
  };
  const grant = (id) => {
    notRepair(id);
    const turn = controller.state.get(id).activeTurn,
      ref = controller.ref(id);
    const current = () => controller.state.get(id).activeTurn === turn && isUserTurn(turn) && controller.ref(id).key === ref.key;
    if (!current()) throw new Error('Repository repair authority must come from the user’s current turn');
    return current;
  };
  async function scope(id) {
    const cwd = await live.peerRuntime.projectOf(id);
    if (!cwd) throw new Error('This chat has no repository folder');
    const root = await command(['rev-parse', '--show-toplevel'], cwd);
    const repo = githubRepo(await command(['remote', 'get-url', 'origin'], root));
    if (!repo || !path.isAbsolute(root)) throw new Error('The chat must use a GitHub origin and an absolute repository folder');
    return { repo, root };
  }
  async function assertScope(policy) {
    const root = await command(['rev-parse', '--show-toplevel'], policy.root);
    const repo = githubRepo(await command(['remote', 'get-url', 'origin'], root));
    if (root !== policy.root || repo !== policy.repo) throw new Error('The authorized repository changed; repair is paused');
  }
  addGuard(controller, 'beforeDispatch', async ({ chatId, item }) => {
    const tag = live.chats.records.get(chatId)?.meta.mainRepair;
    if (tag && item.opts?.human !== true) {
      const job = live.mainRepair.store.data.jobs[tag.reservation],
        policy = live.mainRepair.store.data.policies[tag.repo];
      if (!job || !policy?.enabled || job.generation !== policy.generation || ['failed', 'lost', 'complete'].includes(job.phase))
        throw new Error('This repair no longer owns automatic work');
      if (job.ownedInputId !== item.id) throw new Error('This automatic input does not belong to the repair');
      let expiresAt = Infinity;
      guardSend(item, () => {
        if (clock.now() >= expiresAt) throw new Error('The repair lease expired before dispatch');
      });
      guardInputReady(item, async () => {
        const claim = await live.mainRepair.o.remote('read', job);
        const expiry = Date.parse(claim.worker?.expiresAt);
        if (
          claim.state !== 'claimed' ||
          claim.worker?.reservation !== job.id ||
          claim.worker.chatId !== chatId ||
          !Number.isFinite(expiry) ||
          expiry <= clock.now()
        )
          throw new Error('The repair claim changed before native dispatch');
        if (!policy.enabled || live.mainRepair.store.data.policies[job.repo]?.generation !== job.generation)
          throw new Error('The repair authority changed before native dispatch');
        expiresAt = expiry;
      });
    }
    const dispatch = dispatches.get(item.id);
    if (!dispatch) return;
    await assertScope(dispatch.policy);
    const rt = controller.rt(chatId);
    dispatch.attempt = { token: rt.token, startAttempt: rt.startAttempt };
    if (!dispatch.current()) throw new Error('Main repair authority changed before dispatch');
    dispatch.entered = true;
  });
  return {
    grant,
    ownsTurn,
    scope,
    notRepair,
    assertScope,
    async settings(id, current) {
      const kind = controller.ref(id).kind;
      const inherited = await live.orchestrator.o.childOptions(id, kind, {});
      if (!current()) throw new Error('The user’s repair request changed');
      const { model, effort, permission, planBasePermission, account } = inherited;
      return {
        harness: kind,
        settings: { model, effort, permission, ...(planBasePermission ? { planBasePermission } : {}), ...(account ? { account } : {}) },
      };
    },
    async findPrepared(job) {
      const found = [...live.chats.records].filter(([, r]) => !isMomoMeta(r.meta) && r.meta.mainRepair?.reservation === job.id);
      if (found.length > 1) throw new Error('More than one prepared chat names this repair reservation');
      if (!found.length) return null;
      const [chatId, record] = found[0],
        tag = record.meta.mainRepair;
      if (tag.repo !== job.repo || tag.issue !== job.issue || !path.isAbsolute(tag.cwd) || !/^[0-9a-f]{40}$/.test(tag.baseSha))
        throw new Error('Prepared repair identity is unreadable');
      return { chatId, cwd: tag.cwd, baseSha: tag.baseSha };
    },
    /** @param {import('../../shared/mainRepair').RepairPolicy} policy
     * @param {import('../../shared/mainRepair').RepairJob} job @param {() => boolean} current */
    async prepare(policy, job, current) {
      const check = () => {
        if (!current()) throw new Error('Repair preparation was cancelled');
      };
      await assertScope(policy);
      check();
      await command(['fetch', '--no-write-fetch-head', 'origin', 'refs/heads/main:refs/remotes/origin/main'], policy.root);
      check();
      const baseSha = await command(['rev-parse', 'refs/remotes/origin/main'], policy.root);
      check();
      if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('The fetched main commit is unreadable');
      const family = familyOf(policy.harness),
        parsed = /** @type {NonNullable<ReturnType<typeof parseKind>>} */ (parseKind(policy.harness));
      if (!(await live.orchestrator.o.usable(policy.harness))) throw new Error('The authorized repair harness is unavailable');
      check();
      const starter = live.orchestrator.o.starter;
      const made = await starter.newWorktree(policy.root, { baseCommit: baseSha, what: `main repair #${job.issue}` });
      check();
      if (!made?.path) throw new Error('An isolated main repair worktree could not be prepared');
      const meta = { mainRepair: { repo: job.repo, issue: job.issue, reservation: job.id, cwd: made.path, baseSha } };
      const chatId = await START[family](starter, made.path, policy.root, parsed.basic, { ...policy.settings, meta });
      return { chatId, cwd: made.path, baseSha };
    },
    /** @param {import('../../shared/mainRepair').RepairJob & { chatId: string }} job
     * @param {string} text @param {() => boolean} current */
    async deliver(job, text, current) {
      const id = job.chatId,
        state = controller.state.get(id);
      if (
        !current() ||
        state.turn !== 'idle' ||
        state.queue.length ||
        live.peerRuntime.paused.has(id) ||
        live.chats.records.get(id)?.meta.archived != null
      )
        return { accepted: false, error: 'Repair chat changed before its brief' };
      const ref = controller.ref(id),
        policy = live.mainRepair.store.data.policies[job.repo];
      const item = authoredInput(live.chats, id, text, {
        by: 'mopilot',
        title: `Repair main: #${job.issue}`,
        body: 'A separate worker owns this assigned failure and its verification.',
      });
      // Keep the persisted delivery identity; uncertain acceptance is reconciled, never replayed.
      const shown = live.chats.record(id).meta.authored[item.id];
      if (!saveMeta(live.chats, id, { authored: { ...live.chats.record(id).meta.authored, [job.briefId]: shown } }))
        throw new Error('Could not save the repair brief identity');
      item.id = job.briefId;
      item.authored.id = job.briefId;
      broadcast(id);
      /** @type {{ policy: any, attempt: {token: any, startAttempt: object} | null, entered: boolean, current: () => boolean }} */
      const dispatch = {
        policy,
        attempt: null,
        entered: false,
        current: () =>
          current() &&
          controller.ref(id).key === ref.key &&
          !live.peerRuntime.paused.has(id) &&
          live.chats.records.get(id)?.meta.archived == null,
      };
      const owned = () =>
        dispatch.current() &&
        dispatch.attempt !== null &&
        controller.rt(id).token === dispatch.attempt.token &&
        controller.rt(id).startAttempt === dispatch.attempt.startAttempt;
      dispatches.set(item.id, dispatch);
      const release = guardInput(item, owned);
      try {
        const result = await controller.start(id, item);
        return { accepted: result?.started ? true : dispatch.entered ? null : false, error: result?.error, turnId: result?.turnId };
      } finally {
        dispatches.delete(item.id);
        release();
      }
    },
    activity(job) {
      const id = job.chatId,
        state = controller.state.get(id);
      if (turnHasPerson(state.activeTurn)) return 'user';
      if (live.peerRuntime.paused.has(id) || live.chats.records.get(id)?.meta.archived != null) return 'paused';
      const age = clock.now() - state.progressAt;
      return ownsTurn(job) && Number.isFinite(state.progressAt) && age >= 0 && age < WORKER_LEASE_MS ? 'working' : 'idle';
    },
    async stop(job) {
      const id = job.chatId;
      const row = live.prMonitor?.snapshot(id);
      if (row?.owner === job.id) live.prMonitor.configure(id, { url: row.url, autoFix: false, addressComments: false, continuation: null });
      if (ownsTurn(job)) await controller.stopChat(id);
    },
  };
}
module.exports = { createRepairRuntime, githubRepo };
