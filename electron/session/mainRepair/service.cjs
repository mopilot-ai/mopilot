// Runs one durable, generation-fenced repair per observed break without holding the feature chat or inheriting its context.
const { randomUUID } = require('node:crypto');
const { clock } = require('../../platform/ports/clock.cjs');
const { repairBrief } = require('../../../shared/mainRepairBrief.mjs');
const { userError } = require('../../../shared/userError.mjs');
const { noteIgnored } = require('../../ignored.cjs');
const repairError = (error) => {
  noteIgnored('coordinate main repair', error);
  return userError(error);
};
const TERMINAL = new Set(['failed', 'lost', 'complete']);

class MainRepair {
  constructor(o) {
    this.o = o;
    this.store = o.store;
    this.pending = null;
    this.disposed = false;
    this.errors = new Map();
    /** @type {any} */ this.api = null;
  }
  configure(policy) {
    this.store.change((d) => {
      d.policies[policy.repo] = { ...policy, generation: randomUUID(), authorizedAt: clock.now() };
    });
    return this.status(policy.repo);
  }
  status(repo) {
    const data = this.store.snapshot();
    return {
      policy: data.policies[repo] ?? null,
      jobs: Object.values(data.jobs)
        .filter((j) => j.repo === repo)
        .slice(-10)
        .map(({ id, issue, phase, chatId, cwd, pr, error, updatedAt }) => ({ id, issue, phase, chatId, cwd, pr, error, updatedAt })),
      error: this.errors.get(repo) ?? null,
    };
  }
  current(policy) {
    if (!policy) return false;
    const p = this.store.data.policies[policy.repo];
    return !this.disposed && p?.enabled && p.generation === policy.generation;
  }
  patch(job, fields) {
    this.store.change((d) => {
      Object.assign(d.jobs[job.id], fields, { updatedAt: clock.now() });
    });
    return this.store.data.jobs[job.id];
  }
  owns(job, claim) {
    return (
      claim?.state === 'claimed' &&
      claim.worker?.reservation === job.id &&
      (!job.chatId || !claim.worker.chatId || claim.worker.chatId === job.chatId)
    );
  }
  async read(job) {
    const claim = await this.o.remote('read', job);
    if (!['claimed', 'unclaimed'].includes(claim?.state)) throw new Error('Repair ownership could not be read');
    return claim;
  }
  async release(job, reason) {
    const claim = await this.read(job);
    if (this.owns(job, claim)) await this.o.remote('release', { ...job, from: claim.sha, reservation: job.id, reason });
  }
  async cancel(job, reason) {
    if (this.disposed) return;
    if (job.chatId) await this.o.stop(job);
    await this.release(job, reason);
    this.patch(job, { phase: 'lost', error: reason });
  }
  tick() {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async run() {
    const policies = Object.values(this.store.snapshot().policies);
    for (const policy of policies) {
      try {
        for (const job of Object.values(this.store.data.jobs).filter((j) => j.repo === policy.repo && j.releasePending)) {
          await this.release(job, 'Worker preparation failed');
          this.patch(job, { releasePending: false });
        }
        for (const job of Object.values(this.store.data.jobs).filter((j) => j.repo === policy.repo && !TERMINAL.has(j.phase))) {
          if (!this.current(policy) || job.generation !== policy.generation) await this.cancel(job, 'Repair authority changed');
          else await this.advance(policy, job);
        }
        if (!this.current(policy)) continue;
        const incidents = await this.o.observe(policy);
        if (!this.current(policy)) continue;
        for (const incident of incidents) {
          const related = Object.values(this.store.data.jobs).filter(
            (j) => j.repo === policy.repo && j.issue === incident.issue && j.context === incident.context,
          );
          // Main moving does not retire the issue's active owner or spend another allocation attempt.
          if (related.some((j) => !TERMINAL.has(j.phase))) continue;
          const previous = related.filter((j) => j.failedSha === incident.failedSha);
          const attempts = previous.filter(
            (j) => j.generation === policy.generation && (j.attemptedAt !== undefined || j.chatId || j.phase === 'failed'),
          );
          if (previous.some((j) => j.phase === 'complete') || attempts.length >= 3) continue;
          const id = randomUUID(),
            now = clock.now();
          const job = {
            ...incident,
            id,
            repo: policy.repo,
            phase: 'reserving',
            generation: policy.generation,
            briefId: randomUUID(),
            createdAt: now,
            updatedAt: now,
          };
          this.store.change((d) => {
            d.jobs[id] = job;
          });
          await this.advance(policy, job);
          if (!this.current(policy)) break;
        }
        this.errors.delete(policy.repo);
      } catch (error) {
        this.errors.set(policy.repo, repairError(error));
      }
    }
  }
  async advance(policy, original) {
    let job = this.store.data.jobs[original.id];
    let preparing = false;
    try {
      let claim = await this.read(job);
      if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
      if (job.phase === 'reserving') {
        if (!this.owns(job, claim)) {
          const result = await this.o.remote('reserve', { ...job, reservation: job.id, coordinator: policy.authorizedBy });
          if (!result.ok) {
            this.patch(job, { phase: 'reserving', error: result.why });
            return;
          }
          claim = result.claim;
        }
        job = this.patch(job, { phase: 'reserved', claimSha: claim.sha });
      }
      if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
      const undispatched = ['reserved', 'preparing', 'prepared', 'bound'].includes(job.phase);
      if (undispatched && !this.owns(job, claim)) return this.cancel(job, 'Repair claim changed');
      if (undispatched && Date.parse(claim.worker.expiresAt) <= clock.now()) return this.cancel(job, 'Repair start expired');
      if (['reserved', 'preparing'].includes(job.phase)) {
        const current = await this.o.inspect(job);
        if (!['claimed', 'unclaimed'].includes(current.claim?.state)) throw new Error('Repair ownership could not be read');
        if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
        if (!this.owns(job, current.claim)) return this.cancel(job, 'Repair claim changed before allocation');
        if (current.superseded) return this.cancel(job, 'Assigned failure was superseded');
        const found = await this.o.findPrepared(job);
        if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
        claim = await this.read(job);
        if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
        if (!this.owns(job, claim) || Date.parse(claim.worker.expiresAt) <= clock.now())
          return this.cancel(job, 'Repair claim changed before allocation');
        job = this.patch(job, { phase: 'preparing', attemptedAt: job.attemptedAt ?? clock.now() });
        preparing = true;
        const prepared = found ?? (await this.o.prepare(policy, job, () => this.current(policy)));
        preparing = false;
        job = this.patch(job, { ...prepared, phase: 'prepared' });
        if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
      }
      if (job.phase === 'prepared') {
        claim = await this.read(job);
        if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
        if (!this.owns(job, claim)) return this.cancel(job, 'Repair claim changed before binding');
        if (claim.worker.phase === 'bound') {
          job = this.patch(job, { phase: 'bound', claimSha: claim.sha });
        } else {
          const result = await this.o.remote('bind', { ...job, reservation: job.id, from: claim.sha });
          if (!result.ok) {
            this.patch(job, { error: result.why });
            return;
          }
          job = this.patch(job, { phase: 'bound', claimSha: result.claim.sha });
        }
      }
      if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
      const info = await this.o.inspect(job);
      if (!['claimed', 'unclaimed'].includes(info.claim?.state)) throw new Error('Repair ownership could not be read');
      if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
      if (info.recovered) {
        await this.release(job, 'Assigned failure recovered on main');
        this.patch(job, { phase: 'complete', pr: info.pr ?? job.pr });
        return;
      }
      if (!this.owns(job, info.claim)) {
        await this.cancel(job, 'Repair claim changed');
        return;
      }
      if (info.superseded) {
        await this.cancel(job, 'Assigned failure was superseded');
        return;
      }
      job = this.patch(job, { pr: info.pr ?? null });
      if (Date.parse(info.claim.worker.expiresAt) <= clock.now() && !info.liveCI) return this.cancel(job, 'Repair worker lease expired');
      if (job.phase === 'bound') {
        await this.o.assertScope(policy);
        if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
        const ready = await this.read(job);
        if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
        if (!this.owns(job, ready) || Date.parse(ready.worker.expiresAt) <= clock.now())
          return this.cancel(job, 'Repair claim changed before dispatch');
        job = this.patch(job, { phase: 'dispatching', ownedInputId: job.briefId });
        const sent = await this.o.deliver(job, repairBrief({ ...job, reservation: job.id }), () => this.current(policy));
        if (!this.current(policy)) return this.cancel(job, 'Repair authority changed');
        if (sent.accepted === false) {
          await this.release(job, 'Worker did not accept its brief');
          this.patch(job, { phase: 'failed', error: sent.error });
          return;
        }
        job = this.patch(job, {
          phase: sent.accepted === true ? 'running' : 'uncertain',
          turnId: sent.turnId ?? this.store.data.jobs[job.id].turnId ?? null,
          error: sent.error,
        });
      }
      const activity = this.o.activity(job);
      if (activity === 'user' || activity === 'paused') return;
      if (activity === 'working' || info.liveCI) {
        const phase = info.merged ? 'verifying' : info.liveCI ? 'waiting' : 'running';
        const renewed = await this.o.remote('heartbeat', {
          ...job,
          reservation: job.id,
          from: info.claim.sha,
          chatId: job.chatId,
          phase,
          context: job.context,
        });
        if (this.current(policy) && renewed.ok) this.patch(job, { phase, claimSha: renewed.claim.sha });
      }
    } catch (error) {
      if (this.disposed) return;
      job = this.store.data.jobs[original.id];
      if (['dispatching', 'uncertain'].includes(job.phase)) this.patch(job, { phase: 'uncertain', error: repairError(error) });
      else if (preparing) {
        this.patch(job, { phase: 'failed', error: repairError(error), releasePending: true });
        await this.release(job, 'Worker preparation failed');
        this.patch(job, { releasePending: false });
      } else this.patch(job, { error: repairError(error) });
    }
  }
  dispose() {
    this.disposed = true;
  }
}
module.exports = { MainRepair, TERMINAL };
