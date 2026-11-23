// What the Memory page asks of MoMo's memory on a Host: the app's own list, change log and undo over the open store; a change made since the one to undo is refused.
import { createRequire } from 'node:module';
import { HostRefusal } from './hostFs.mjs';

const require = createRequire(import.meta.url);
const { MemoryError } = require('../../electron/momo/memoryFacts.cjs');

/** @param {{ stores: () => { memory?: any } | null, machine: () => string }} home */
export function createMemoryOps(home) {
  return {
    /** @param {{ op: 'list' | 'changes' | 'undo', id?: string }} p */
    async memory({ op, id }) {
      const memory = home.stores()?.memory;
      if (!memory) throw new HostRefusal('momo_unavailable', `MoMo is not available on ${home.machine()} right now.`);
      if (op === 'list') return memory.list({ includeExpired: true });
      if (op === 'changes') return { changes: memory.changes().slice(0, 30) };
      try {
        return { change: await memory.undo(/** @type {string} */ (id), { by: 'user' }) };
      } catch (error) {
        if (error instanceof MemoryError) throw new HostRefusal(`momo_memory_${error.code}`, error.message);
        throw error;
      }
    },
  };
}
