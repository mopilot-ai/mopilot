// Validates durable main-repair worker generations and bounded leases shared by CLI, sweep and app coordination.
export const RESERVATION_MS = 2 * 60_000;
export const WORKER_LEASE_MS = 20 * 60_000;
export const WORKER_PHASES = ['reserved', 'bound', 'running', 'waiting', 'verifying'];
/** @typedef {{ reservation: string, coordinator: string, phase: string, chatId: string | null, cwd: string | null, baseSha: string | null, heartbeat: string, expiresAt: string }} RepairWorker */
const text = (value) => typeof value === 'string' && value.length > 0;

export function validWorker(worker) {
  if (!worker || !text(worker.reservation) || !text(worker.coordinator) || !WORKER_PHASES.includes(worker.phase)) return false;
  const heartbeat = Date.parse(worker.heartbeat),
    expiry = Date.parse(worker.expiresAt);
  if (!Number.isFinite(heartbeat) || !Number.isFinite(expiry) || expiry <= heartbeat || expiry - heartbeat > WORKER_LEASE_MS) return false;
  return worker.phase === 'reserved'
    ? worker.chatId === null && worker.cwd === null && worker.baseSha === null
    : text(worker.chatId) && text(worker.cwd) && /^[0-9a-f]{40}$/.test(worker.baseSha);
}

export const workerClaimant = (chatId) => `repair-worker:${chatId}`;
