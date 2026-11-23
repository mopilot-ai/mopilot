// Composes the opt-in repository repair coordinator at app startup; no window or always-on external service is needed.
const path = require('node:path');
const { MainRepairStore } = require('../../session/mainRepair/store.cjs');
const { MainRepair } = require('../../session/mainRepair/service.cjs');
const { createRepairGithub } = require('../../platform/mainRepairGithub.cjs');
const { createRepairRuntime } = require('../mainRepairRuntime.cjs');
const { ownerOf } = require('../../platform/segmentOwner.cjs');
const { clock } = require('../../platform/ports/clock.cjs');
const { addHook } = require('../../session/hookChain.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { userError } = require('../../../shared/userError.mjs');
const { isMomoMeta } = require('../../../shared/momoChat.mjs');
function register(_ipcMain, { app, live, broadcastAll }, injected = {}) {
  const store = injected.store ?? new MainRepairStore({ file: path.join(app.getPath('userData'), 'main-repairs.json') });
  const github = injected.github ?? createRepairGithub();
  const runtime =
    injected.runtime ?? createRepairRuntime({ live, broadcast: (id) => broadcastAll('chats:changed', { id, chat: live.chats.get(id) }) });
  const service = new MainRepair({
    store,
    ...runtime,
    remote: (op, payload) => github.request(op, payload),
    observe: (policy) => github.request('observe', { repo: policy.repo }),
    inspect: (job) => github.request('inspect', job),
  });
  live.mainRepair = service;
  const own = (id, ctx) => {
    if (isMomoMeta(live.chats.records.get(id)?.meta)) throw new Error('Repository repair is unavailable in this chat');
    if (ownerOf(live.chats.records, ctx, { current: true }) !== id) throw new Error('The repair caller’s current segment changed');
  };
  const tick = () => {
    void service.tick().catch((error) => {
      noteIgnored('resume main repairs', error);
      service.errors.set('startup', userError(error));
    });
  };
  const jobOf = (id) => {
    const tag = live.chats.records.get(id)?.meta.mainRepair,
      job = tag && store.data.jobs[tag.reservation];
    return job && job.chatId === id && service.current(store.data.policies[job.repo]) && !['failed', 'lost', 'complete'].includes(job.phase)
      ? job
      : null;
  };
  addHook(live.controller, 'onDispatchResult', ({ chatId, item, result }) => {
    const job = jobOf(chatId);
    if (job?.ownedInputId === item.id && result?.started && result.turnId) {
      try {
        service.patch(job, { turnId: result.turnId });
      } catch (error) {
        noteIgnored('record the repair turn receipt', error);
        service.errors.set(job.repo, userError(error));
      }
    }
  });
  service.api = {
    monitorOwner(id) {
      const job = jobOf(id);
      return job && runtime.ownsTurn(job) ? job.id : null;
    },
    monitorInput(id, item, owner) {
      if (!owner) return;
      const job = jobOf(id);
      if (!job || job.id !== owner) throw new Error('The repair no longer owns this PR follow-up');
      service.patch(job, { ownedInputId: item.id, turnId: null });
    },
    async configure(id, args, ctx) {
      own(id, ctx);
      const current = runtime.grant(id),
        scope = await runtime.scope(id);
      // The status identities and release workflows implemented here belong to this repository's CI protocol.
      if (scope.repo !== 'mopilot-ai/mopilot-internal')
        throw new Error('This repository does not use MoPilot’s supported main-red CI protocol');
      const old = store.data.policies[scope.repo];
      const selected = args.enabled ? await runtime.settings(id, current) : (old ?? (await runtime.settings(id, current)));
      own(id, ctx);
      if (!current()) throw new Error('The user’s repair request changed');
      const result = service.configure({ ...selected, ...scope, enabled: args.enabled, authorizedBy: id });
      tick();
      return result;
    },
    async request(id, _args, ctx) {
      own(id, ctx);
      runtime.notRepair(id);
      const scope = await runtime.scope(id);
      own(id, ctx);
      if (!store.data.policies[scope.repo]?.enabled) throw new Error('Automatic main repair has not been authorized for this repository');
      tick();
      return {
        ...service.status(scope.repo),
        requested: true,
        message: 'Repair reconciliation requested. Continue independent work while the claim’s worker handles repair and verification.',
      };
    },
    async status(id, _args, ctx) {
      own(id, ctx);
      const scope = await runtime.scope(id);
      own(id, ctx);
      return service.status(scope.repo);
    },
  };
  const timer = clock.setInterval(tick, 60_000);
  timer.unref();
  const initial = clock.setTimeout(tick, 0);
  app.once('will-quit', () => {
    clock.clearTimeout(initial);
    clock.clearInterval(timer);
    service.dispose();
    github.close();
  });
  return service;
}
module.exports = { register };
