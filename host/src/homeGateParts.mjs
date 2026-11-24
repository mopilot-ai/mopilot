// The small parts of MoMo's home gate that stand on their own: which starts the protocol is still working on, the keyed chat marker beside each task folder, and the few copies kept of a state that was set aside.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** How long a removal waits for a start the protocol is still working on before it stops what it can see. */
export const LAND_MS = 30_000;
/** How long a start counts as with the protocol when its call never answers (the gate's own pending expiry). */
const FLIGHT_TTL_MS = 10 * 60_000;
/** How many set-aside copies of the damaged state are kept of each kind. */
const ASIDE_KEEP = 5;

/**
 * The chats whose start the protocol is working on, by who asked (one entry per request); a call that never answers stops counting after ten minutes.
 * @param {{ now?: () => number }} [o]
 */
export function createFlight({ now = Date.now } = {}) {
  /** @type {Map<string, { fingerprint: string, at: number }[]>} */
  const flying = new Map();
  /** @type {Set<() => void>} */
  const waiters = new Set();
  const live = (/** @type {string} */ chatId) => (flying.get(chatId) ?? []).filter((e) => now() - e.at < FLIGHT_TTL_MS);
  /** @param {string} fingerprint */
  const inFlight = (fingerprint) => [...flying.keys()].some((id) => live(id).some((e) => e.fingerprint === fingerprint));
  return {
    /** A start of `chatId` by `fingerprint` is with the protocol: the returned call ends it and says whether another start of that chat is still with it. @param {string} chatId @param {string} fingerprint */
    begin(chatId, fingerprint) {
      const entry = { fingerprint, at: now() };
      flying.set(chatId, [...live(chatId), entry]);
      return () => {
        const rest = live(chatId).filter((e) => e !== entry);
        if (rest.length > 0) flying.set(chatId, rest);
        else flying.delete(chatId);
        for (const w of [...waiters]) w();
        return rest.length > 0;
      };
    },
    /** Waits (a while at most) until no start of the home is with the protocol. @param {string} fingerprint */
    settled: (fingerprint) =>
      new Promise((resolve) => {
        if (!inFlight(fingerprint)) return resolve(undefined);
        const end = () => {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(undefined);
        };
        const check = () => inFlight(fingerprint) || end();
        const timer = setTimeout(end, LAND_MS);
        timer.unref?.();
        waiters.add(check);
      }),
  };
}

/**
 * The chat id written beside each task folder (`<hash>.chat`), so what runs under the work folder can be named when the state cannot be read. A marker carries a keyed proof (the key is in the Host's config folder, not beside the folders), so one planted in the work folder names nothing. A lost or replaced key makes every marker unverifiable, and repair says how many (`unverified`). The key is covered by the managed deny list for the config folder (#5614 once it lands); a shell of the same OS user can still read it (#5617).
 * @param {string} configDir
 */
export function createMarkers(configDir) {
  const keyFile = path.join(configDir, 'home-marker.key');
  const key = () => {
    try {
      return fs.readFileSync(keyFile);
    } catch {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      try {
        fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
      } catch {
        // another start made it first
      }
      return fs.readFileSync(keyFile);
    }
  };
  const proof = (/** @type {string} */ hash, /** @type {string} */ id) =>
    crypto.createHmac('sha256', key()).update(`${hash}\n${id}`).digest('hex');
  return {
    /** @param {string} cwd the task folder @param {string} chatId */
    write(cwd, chatId) {
      fs.writeFileSync(`${cwd}.chat`, `${chatId}\n${proof(path.basename(cwd), chatId)}`, { mode: 0o600 });
    },
    /** @param {string} cwd */
    remove: (cwd) => fs.rmSync(`${cwd}.chat`, { force: true }),
    /** The chat a marker file names, or null when its name is not the folder's, its proof does not hold, or its folder is not there. @param {string} workDir @param {string} file */
    read(workDir, file) {
      const hash = file.slice(0, -'.chat'.length);
      const [id, mac] = fs.readFileSync(path.join(workDir, file), 'utf8').split('\n');
      const named = crypto.createHash('sha256').update(id).digest('hex').slice(0, 32) === hash;
      const sound = typeof mac === 'string' && mac.length === 64 && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(proof(hash, id)));
      return named && sound && fs.existsSync(path.join(workDir, hash)) ? id : null;
    },
  };
}

/**
 * Stops every session that runs under the task work folder, named by the markers beside the folders: what a damaged state can no longer say. Answers how many it stopped, and how many markers it could not trust (a planted one, or any after the key was lost: those sessions may still run).
 * @param {{ workDir: string, markers: ReturnType<typeof createMarkers>, known: (id: string) => boolean, stop: (id: string) => unknown, report: (message: string) => void }} o
 */
export async function stopUnder({ workDir, markers, known, stop, report }) {
  let stopped = 0;
  /** @type {string[]} */
  let names = [];
  try {
    names = fs.readdirSync(workDir).filter((f) => f.endsWith('.chat'));
  } catch {
    return { stopped, unverified: 0 };
  }
  let unverified = 0;
  for (const f of names) {
    try {
      const id = markers.read(workDir, f);
      if (!id) unverified++;
      if (!id || !known(id)) continue;
      await stop(id);
      stopped++;
    } catch (e) {
      report(`A MoMo task session could not be stopped after its state was repaired: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { stopped, unverified };
}

/** The highest lease the floor file holds: null when none was written, undefined when it cannot be read (or was itself damaged: that is not an empty one). @param {{ read: () => { newest: { homeId: string, leaseEpoch: number } | null }, setAside: string | null }} floorFile */
export function floorOf(floorFile) {
  try {
    const { newest } = floorFile.read();
    return floorFile.setAside ? undefined : newest;
  } catch {
    return undefined;
  }
}

/** The audit line's facts for a repair. @param {{ stopped: number, unverified: number }} r */
export const repairWhat = (r) => ({ status: 'repaired', outcome: `stopped ${r.stopped}, unverified ${r.unverified}` });

/** Keeps the newest few copies of each state file that was set aside, of each kind. @param {string} configDir @param {string[]} names the state files' names */
export function trimAside(configDir, names) {
  for (const name of names)
    for (const kind of ['unreadable', 'damaged'])
      try {
        const prefix = `${name}.${kind}-`;
        const copies = fs
          .readdirSync(configDir)
          .filter((f) => f.startsWith(prefix))
          .map((f) => ({ f, at: fs.statSync(path.join(configDir, f)).mtimeMs }))
          .sort((a, b) => b.at - a.at);
        for (const old of copies.slice(ASIDE_KEEP)) fs.rmSync(path.join(configDir, old.f), { force: true });
      } catch {
        // a copy that cannot be trimmed is only kept
      }
}
