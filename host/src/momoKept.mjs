// What MoMo's home keeps beside its record (home lane): the ids of the turns a Reset deleted (so an old id reads settled, never "safe to send again"; sealed with MoMo's data key, so a move carries them) and the newest lease this Host has seen stamped for a home (so a stamp older than it is refused; sealed with the Host's own key, never moved: it is this machine's own memory).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createStampSink } from '../../shared/momoStamp.mjs';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');

/** How many deleted turn ids a Reset keeps as void. */
const VOID_KEEP = 2000;

/**
 * @param {object} o
 * @param {string} o.dir MoMo's folder on this Host
 * @param {import('../../electron/platform/secretFile.cjs').SafeStorage} o.hostSafe the Host's key (the newest lease seen)
 * @param {import('../../electron/platform/secretFile.cjs').SafeStorage} o.dataSafe MoMo's data key (the void ids)
 * @param {() => number} o.now
 * @param {(message: string) => void} o.report
 */
export function createMomoKept({ dir, hostSafe, dataSafe, now, report }) {
  /** A file that is not there is the empty record, read without making MoMo's folder. @template T @param {{ read: () => T }} file @param {string} name @param {(v: any) => T} shape @returns {T} */
  const read = (file, name, shape) => (fs.existsSync(path.join(dir, name)) ? file.read() : shape(null));

  /** @param {any} v */
  const voidShape = (v) => ({ ids: Array.isArray(v?.ids) ? v.ids.filter((/** @type {unknown} */ i) => typeof i === 'string') : [] });
  const voidFile = new SealedJson({ file: path.join(dir, 'turns-void.json'), safeStorage: dataSafe, shape: voidShape, now });
  /** @type {Set<string> | null} */
  let voided = null;

  /** @param {any} v */
  const stampShape = (v) => ({
    newest:
      typeof v?.newest?.homeId === 'string' && Number.isSafeInteger(v.newest.leaseEpoch)
        ? { homeId: v.newest.homeId, leaseEpoch: v.newest.leaseEpoch }
        : null,
  });
  const stampFile = new SealedJson({ file: path.join(dir, 'stamps.json'), safeStorage: hostSafe, shape: stampShape, now });
  /** @type {{ homeId: string, leaseEpoch: number } | null | undefined} */
  let newest;
  const sink = createStampSink({
    read: () => (newest !== undefined ? newest : (newest = read(stampFile, 'stamps.json', stampShape).newest)),
    write: (n) => {
      newest = n;
      // the answer waits for this: a receiver killed right after it said yes must not forget the lease and trust the older twin again
      keeping = stampFile.change((v) => void (v.newest = n));
    },
  });
  /** The write the last accepted stamp started. @type {Promise<unknown> | null} */
  let keeping = null;

  return {
    /** Whether the id belongs to a turn a Reset deleted. @param {string} turnId */
    voided: (turnId) => (voided ??= new Set(read(voidFile, 'turns-void.json', voidShape).ids)).has(turnId),
    /** Keep these ids as void (the newest few thousand). @param {string[]} ids */
    async voidAll(ids) {
      if (ids.length === 0) return;
      await voidFile.change((v) => {
        v.ids = [...new Set([...v.ids, ...ids])].slice(-VOID_KEEP);
      });
      voided = null;
    },
    /** The newest lease epoch this Host has seen in any stamp (0 before any): a new home, a stand-down and an adopted move clear it, not only this Host's own record. */
    newestEpoch: () => sink.newest()?.leaseEpoch ?? 0,
    /** The ids came in a bundle (or the key changed): read them afresh. */
    forgetCache() {
      voided = null;
    },
    /**
     * Take a stamp that arrived from another Host or a push: refused when older than the newest lease seen. An accepted newer one is on disk
     * before this answers; when it cannot be kept, it is refused (never believed for a moment and then forgotten). @param {unknown} stamp
     * @returns {Promise<ReturnType<typeof sink.accept> | { ok: false, reason: 'not-kept', newest: null }>}
     */
    async receiveStamp(stamp) {
      keeping = null;
      const taken = sink.accept(stamp);
      if (!keeping) return taken;
      try {
        await keeping;
        return taken;
      } catch (error) {
        newest = undefined;
        report(`MoMo could not keep the newest lease seen: ${/** @type {Error} */ (error).message}`);
        return { ok: false, reason: 'not-kept', newest: null };
      }
    },
  };
}
