// Executes only named repair claim/observation operations in a worker, with bounded gh children and no shell interpolation.
const { parentPort, workerData } = require('node:worker_threads');
const { execFileSync } = require('node:child_process');
const { readClaim } = require('../../shared/mainRedClaims.mjs');
const { reserveRepair, bindRepair, heartbeatRepair, releaseRepair } = require('../../shared/mainRepairClaims.mjs');
const { observeRepairs, inspectRepair } = require('../../shared/mainRepairObservations.mjs');
const { userError } = require('../../shared/userError.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { validRepository } = require('../../shared/mainRepairRepository.mjs');
const OPERATIONS = Object.freeze({
  read: readClaim,
  reserve: reserveRepair,
  bind: bindRepair,
  heartbeat: heartbeatRepair,
  release: releaseRepair,
  observe: observeRepairs,
  inspect: inspectRepair,
});
function executeRepair({ op, payload, environment }, execute = execFileSync) {
  const operation = Object.hasOwn(OPERATIONS, op) && OPERATIONS[op];
  if (!operation || !validRepository(payload?.repo)) throw new Error('Invalid main repair operation');
  const gh = (args) =>
    execute('gh', args, {
      encoding: 'utf8',
      env: environment,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return operation({ ...payload, gh });
}
if (parentPort) {
  try {
    parentPort.postMessage({ ok: true, result: executeRepair(workerData) });
  } catch (error) {
    noteIgnored('read main repair GitHub state', error);
    parentPort.postMessage({ ok: false, error: userError(error) });
  }
}
module.exports = { executeRepair };
