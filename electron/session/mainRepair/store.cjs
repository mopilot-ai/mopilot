// Persists repository-scoped repair authority and worker transitions before any external start or dispatch.
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { parseKind } = require('../../../shared/harnessKind.mjs');
const { validRepository: repository } = require('../../../shared/mainRepairRepository.mjs');
const PHASES = new Set([
  'reserving',
  'reserved',
  'preparing',
  'prepared',
  'bound',
  'dispatching',
  'running',
  'waiting',
  'verifying',
  'uncertain',
  'failed',
  'lost',
  'complete',
]);
const text = (v) => typeof v === 'string' && !!v;
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function validStore(data) {
  return (
    data?.version === 1 &&
    object(data.policies) &&
    object(data.jobs) &&
    Object.entries(data.policies).every(
      ([key, p]) =>
        object(p) &&
        p.repo === key &&
        repository(key) &&
        text(p.root) &&
        path.isAbsolute(p.root) &&
        typeof p.enabled === 'boolean' &&
        text(p.generation) &&
        parseKind(p.harness) &&
        object(p.settings) &&
        text(p.authorizedBy) &&
        Number.isFinite(p.authorizedAt),
    ) &&
    Object.entries(data.jobs).every(
      ([key, j]) =>
        object(j) &&
        j.id === key &&
        repository(j.repo) &&
        Number.isSafeInteger(j.issue) &&
        j.issue > 0 &&
        text(j.context) &&
        /^[0-9a-f]{40}$/.test(j.failedSha) &&
        PHASES.has(j.phase) &&
        text(j.generation) &&
        text(j.briefId) &&
        Number.isFinite(j.createdAt) &&
        Number.isFinite(j.updatedAt) &&
        (j.attemptedAt === undefined || Number.isFinite(j.attemptedAt)) &&
        (j.releasePending === undefined || typeof j.releasePending === 'boolean') &&
        (j.chatId === undefined || text(j.chatId)) &&
        (j.cwd === undefined || (text(j.cwd) && path.isAbsolute(j.cwd))) &&
        (j.baseSha === undefined || /^[0-9a-f]{40}$/.test(j.baseSha)),
    )
  );
}

class MainRepairStore {
  constructor({
    file,
    read = () => fs.readFileSync(file, 'utf8'),
    write = (data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writePrivate(file, JSON.stringify(data));
    },
  }) {
    this.write = write;
    /** @type {import('../../../shared/mainRepair').RepairSnapshot} */ this.data = { version: 1, policies: {}, jobs: {} };
    this.error = null;
    try {
      this.data = JSON.parse(read());
      if (!validStore(this.data)) throw new Error('Invalid main repair store');
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = error;
    }
  }
  check() {
    if (this.error) throw this.error;
  }
  change(fn) {
    this.check();
    const next = structuredClone(this.data);
    fn(next);
    if (!validStore(next)) throw new Error('Invalid main repair transition');
    const durable = JSON.parse(JSON.stringify(next));
    this.write(durable);
    this.data = durable;
  }
  snapshot() {
    this.check();
    return structuredClone(this.data);
  }
}
module.exports = { MainRepairStore, validStore };
