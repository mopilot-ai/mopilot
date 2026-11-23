// Reserves each break before allocation, binds a stable worker before dispatch, and fences every heartbeat/release by generation.
import { claim, readClaim, changeClaim, retire } from './mainRedClaims.mjs';
import { RESERVATION_MS, WORKER_LEASE_MS, validWorker, workerClaimant } from './mainRepairClaim.mjs';
import { liveRepairWait } from './mainRepairWait.mjs';

export function reserveRepair({ gh, repo, issue, reservation, coordinator, now = Date.now() }) {
  const worker = {
    reservation,
    coordinator,
    phase: 'reserved',
    chatId: null,
    cwd: null,
    baseSha: null,
    heartbeat: new Date(now).toISOString(),
    expiresAt: new Date(now + RESERVATION_MS).toISOString(),
  };
  if (!validWorker(worker)) throw new Error('Invalid repair reservation');
  return claim({ gh, repo, issue, claimant: `repair-reservation:${reservation}`, worker, now });
}

/** @returns {current is import('./mainRedClaims.mjs').Claim & {state: 'claimed', sha: string, worker: import('./mainRepairClaim.mjs').RepairWorker}} */
function owns(current, reservation, from) {
  return current.state === 'claimed' && current.worker?.reservation === reservation && current.sha === from;
}

export function bindRepair({ gh, repo, issue, reservation, from, chatId, cwd, baseSha, now = Date.now() }) {
  const current = readClaim({ gh, repo, issue });
  if (!owns(current, reservation, from) || current.worker.phase !== 'reserved')
    return { ok: false, claim: current, why: 'Repair reservation changed; do not dispatch a worker' };
  const worker = {
    ...current.worker,
    phase: 'bound',
    chatId,
    cwd,
    baseSha,
    heartbeat: new Date(now).toISOString(),
    expiresAt: new Date(now + WORKER_LEASE_MS).toISOString(),
  };
  if (!validWorker(worker)) throw new Error('Invalid repair worker binding');
  if (Date.parse(current.worker.expiresAt) <= now)
    return { ok: false, claim: current, why: 'Repair reservation expired; do not dispatch a worker' };
  const { state: _state, sha: _sha, ...record } = current;
  return changeClaim({ gh, repo, issue, from, record: { ...record, claimant: workerClaimant(chatId), worker } });
}

/** Only the bound worker generation can renew; runtime supplies proven work/CI activity rather than a pending status alone. */
export function heartbeatRepair({
  gh,
  repo,
  issue,
  reservation,
  from,
  chatId,
  phase,
  context = '',
  releaseRepo = 'mopilot-ai/mopilot-code-release',
  now = Date.now(),
}) {
  const current = readClaim({ gh, repo, issue });
  if (
    !owns(current, reservation, from) ||
    current.worker.chatId !== chatId ||
    current.worker.phase === 'reserved' ||
    (Date.parse(current.worker.expiresAt) <= now && !liveRepairWait({ gh, repo, claim: current, context, releaseRepo, now }))
  )
    return { ok: false, claim: current, why: 'Worker ownership changed or expired; stop this repair' };
  const worker = {
    ...current.worker,
    phase,
    heartbeat: new Date(now).toISOString(),
    expiresAt: new Date(now + WORKER_LEASE_MS).toISOString(),
  };
  if (phase === 'reserved' || !validWorker(worker)) throw new Error('Invalid repair heartbeat');
  const { state: _state, sha: _sha, ...record } = current;
  return changeClaim({ gh, repo, issue, from, record: { ...record, worker } });
}

export function releaseRepair({ gh, repo, issue, reservation, from, reason, now = Date.now() }) {
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Repair release needs a reason');
  const current = readClaim({ gh, repo, issue });
  if (!owns(current, reservation, from)) return { ok: false, claim: current, why: 'Repair ownership changed; preserve the replacement' };
  try {
    return { ok: retire({ gh, repo, issue, from, reason, now }).released };
  } catch (error) {
    const read = readClaim({ gh, repo, issue });
    if (read.state === 'unclaimed') return { ok: true };
    throw error;
  }
}
