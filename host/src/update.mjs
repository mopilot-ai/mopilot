// `update`: stages a content-addressed Host version (checksum-verified before it is kept), and restarts the Host into it only when it is idle.
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOST_CORE_ADDON, HOST_CORE_DIR, HOST_CORE_RECORD, coreBuildHere } from '../../shared/host/coreBuild.mjs';
import { checkManifest } from '../../shared/host/updateSignature.mjs';
import { createPairing } from './pairing.mjs';
import { createUpdateKeys } from './updateKeys.mjs';
import { withTrustWrite } from './trustWrite.mjs';

/** What `update` may fetch from: an https URL or a local path (a file the person copied here). */
const REMOTE = /^https:\/\//i;
const SHA256 = /^[0-9a-f]{64}$/;
/** The most a manifest or an archive may be: a bundle of the Host is some tens of MB. */
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** How many redirects a download follows, all of them to the same host. */
const MAX_REDIRECTS = 3;
/** How many starts of a staged version that never served are tolerated before it is dropped. */
const MAX_TRIES = 3;
/** Where the idle check looks again while a restart waits for the Host to go idle. */
const IDLE_POLL_MS = 500;

/** The folders and pointers of a Host's versions, all under its data dir. @param {string} dataDir */
export function updatePaths(dataDir) {
  const root = path.join(dataDir, 'updates');
  return {
    root,
    blob: (/** @type {string} */ sha) => path.join(root, 'blobs', `${sha}.tgz`),
    version: (/** @type {string} */ sha) => path.join(root, 'versions', sha),
    next: path.join(root, 'next.json'),
    /** The newest build taken, `{ seq, sha256 }`: nothing older is taken after it. */
    floor: path.join(root, 'floor.json'),
    active: path.join(root, 'active.json'),
  };
}

/** @param {string} file @returns {{ version: string, sha256: string } | null} */
function readPointer(file) {
  try {
    const found = JSON.parse(fs.readFileSync(file, 'utf8'));
    return SHA256.test(found?.sha256) ? found : null;
  } catch {
    return null;
  }
}

/** The staged version's CLI, when a version was activated and is still on disk; null runs the code this process was started from. @param {string} dataDir */
export function activeCli(dataDir) {
  const p = updatePaths(dataDir);
  const active = readPointer(p.active);
  const cli = active && path.join(p.version(active.sha256), 'src', 'cli.mjs');
  if (!cli || !fs.existsSync(cli)) return null;
  // a version that was started MAX_TRIES times without ever serving (see markHealthy) is not started again: the code this process came from runs instead
  const tries = Number(/** @type {any} */ (active).tries ?? 0);
  if (tries >= MAX_TRIES) return null;
  fs.writeFileSync(p.active, JSON.stringify({ ...active, tries: tries + 1 }));
  return { ...active, cli };
}

/** The active version came up and is serving: its start counts are cleared. @param {string} dataDir */
export function markHealthy(dataDir) {
  const p = updatePaths(dataDir);
  const active = readPointer(p.active);
  if (active) fs.writeFileSync(p.active, JSON.stringify({ ...active, tries: 0 }));
}

/** Whether this Host trusts any key for updates: an update key file, or a paired app (so `status` can say manifests are verified). A pairing file that cannot be read counts as none. @param {string} configDir */
export function hasUpdateKey(configDir) {
  if (fs.existsSync(path.join(configDir, 'update-key.pub'))) return true;
  try {
    return createPairing({ configDir }).paired() > 0;
  } catch {
    return false;
  }
}

/**
 * What `status` says of updates: whether a key is trusted (`updateKey`) and, while a staged version waits to be run, `pendingUpdate` `{ version, build }`: the build this Host will become (read from the staged archive; '' when it records none). Another app that finds the Host older sees it and leaves it alone until it has restarted.
 * @param {{ configDir: string, dataDir: string }} paths
 * @returns {{ updateKey: boolean, pendingUpdate?: { version: string, build: string } }}
 */
export function updateFacts({ configDir, dataDir }) {
  const p = updatePaths(dataDir);
  const next = readPointer(p.next);
  if (!next || !fs.existsSync(p.version(next.sha256))) return { updateKey: hasUpdateKey(configDir) };
  let build = '';
  try {
    build = fs.readFileSync(path.join(p.version(next.sha256), 'host', 'BUILD_ID'), 'utf8').trim();
  } catch {
    // an archive that records none
  }
  return { updateKey: hasUpdateKey(configDir), pendingUpdate: { version: next.version, build } };
}

/**
 * The keys an update manifest may be signed by, with their ids and when this Host last heard from each: the update key file, every app paired with this Host (an app that can already run chats here can say what runs here) and the keys signed updates added, less the revoked ones.
 * @param {string} configDir
 * @returns {import('../../shared/host/updateSignature.mjs').TrustedKey[]}
 */
export function trustedUpdateKeys(configDir) {
  return updateKeysOf(configDir).entries();
}

/** The store of the keys this Host takes updates from (updateKeys.mjs): the update key file, the paired apps and the keys signed updates added. @param {string} configDir */
export function updateKeysOf(configDir) {
  return createUpdateKeys({ configDir, fileKey: () => readUpdateKey(configDir) });
}

/** Keep `pem` as this Host's update key, after checking it is an Ed25519 public key. @param {string} configDir @param {string} pem */
export function writeUpdateKey(configDir, pem) {
  let type;
  try {
    type = createPublicKey(pem).asymmetricKeyType;
  } catch {
    type = null;
  }
  if (type !== 'ed25519') throw new Error('That is not an Ed25519 public key (PEM).');
  return withTrustWrite(configDir, () => {
    fs.writeFileSync(path.join(configDir, 'update-key.pub'), pem, { mode: 0o600 });
  });
}

/**
 * The public key this Host verifies update manifests with, from `<config dir>/update-key.pub` (PEM); null only when there is no such file.
 * A file that cannot be read or is not an Ed25519 public key is an error: verification is never switched off by a broken key.
 * @param {string} configDir
 */
export function readUpdateKey(configDir) {
  const file = path.join(configDir, 'update-key.pub');
  let pem;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return null;
    throw new Error(`${file} cannot be read (${/** @type {any} */ (e).code}); update manifests cannot be verified.`);
  }
  let type;
  try {
    type = createPublicKey(pem).asymmetricKeyType;
  } catch {
    type = null;
  }
  if (type !== 'ed25519') throw new Error(`${file} is not an Ed25519 public key (PEM); update manifests cannot be verified.`);
  return pem;
}

/** The bytes at a manifest's source: https, or a local file. At most `max`; an https source may redirect only to https on its own host. @param {string} source @param {typeof fetch} fetchFn @param {number} max */
async function readSource(source, fetchFn, max) {
  if (!REMOTE.test(source)) {
    if (fs.statSync(source).size > max) throw new Error(`${source} is larger than an update may be.`);
    return fs.readFileSync(source);
  }
  const origin = new URL(source).hostname;
  let url = source;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const res = await fetchFn(url, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get('location') ?? '', url);
      if (next.protocol !== 'https:' || next.hostname !== origin)
        throw new Error(`${source} sends the download to ${next.hostname}, which this Host does not follow.`);
      url = next.href;
      continue;
    }
    if (!res.ok) throw new Error(`Could not fetch ${source} (${res.status}).`);
    if (Number(res.headers.get('content-length')) > max) throw new Error(`${source} is larger than an update may be.`);
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (res.body ?? [])) {
      size += chunk.length;
      if (size > max) throw new Error(`${source} is larger than an update may be.`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`${source} redirects more than ${MAX_REDIRECTS} times.`);
}

/** The newest build this Host has taken. @param {string} dataDir @returns {{ seq: number, sha256: string } | null} */
function readFloor(dataDir) {
  try {
    const f = JSON.parse(fs.readFileSync(updatePaths(dataDir).floor, 'utf8'));
    return Number.isSafeInteger(f?.seq) && SHA256.test(f?.sha256) ? { seq: f.seq, sha256: f.sha256 } : null;
  } catch {
    return null;
  }
}

/**
 * Why this machine's Node does not load `file`, or '': asked in a child, so a Host never restarts into a core that would stop it starting, and one that crashes takes only the child with it.
 * @param {string} file @param {typeof spawnSync} [run]
 */
export function addonLoads(file, run = spawnSync) {
  const child = run(process.execPath, ['-e', 'process.dlopen({ exports: {} }, process.argv[1])', file], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (child.status === 0) return '';
  return (
    String(child.stderr)
      .split('\n')
      .find((line) => /error/i.test(line))
      ?.trim() ?? `it stopped with ${child.status ?? child.signal}`
  );
}

/**
 * Why an unpacked version must not run here, or '' when it may: its Rust core is for another machine, or is not the file its record names. The app picks the build, and this keeps a wrong pick off a Host that works; the signed checksum covers record and addon alike, so this is about what the app chose and what arrived, not who sent it.
 * @param {string} dir the unpacked version @param {string} [here] this machine's build @param {(addon: string) => string} [loads] why it does not load here, or ''
 */
export function coreRefusal(dir, here = coreBuildHere(), loads = addonLoads) {
  const core = path.join(dir, HOST_CORE_DIR);
  if (!fs.existsSync(core)) return 'The update carries no Rust core; it was not kept.';
  try {
    const { build, sha256 } = JSON.parse(fs.readFileSync(path.join(core, HOST_CORE_RECORD), 'utf8'));
    if (build !== here) return `The update is built for ${build}, and this machine needs ${here}; it was not kept.`;
    const actual = createHash('sha256')
      .update(fs.readFileSync(path.join(core, HOST_CORE_ADDON)))
      .digest('hex');
    if (actual !== sha256) return 'The update’s Rust core does not match its record; it was not kept.';
    const failed = loads(path.join(core, HOST_CORE_ADDON));
    return failed && `The update’s Rust core does not load on this machine, so it was not kept: ${failed}`;
  } catch {
    return 'The update’s Rust core could not be read; it was not kept.';
  }
}

/**
 * Fetch the manifest `{ version, sha256, url, hostId, seq, notAfter, signature }`, then the archive it names, and keep the archive only when its SHA-256 is the one the manifest promises.
 * The manifest must be signed by one of `keys` (Ed25519 public keys, PEM: the update key and the app's paired keys) for this Host (`hostId`), still good and newer than the newest build taken; with no key nothing is taken. Nothing is downloaded before that is settled.
 * The archive is unpacked into versions/<sha256>, checked for this machine (`coreRefusal`) and becomes the next version to run. No network is used at Host start.
 * `keyStore` (updateKeys.mjs) is told of the key that signed it once the update is taken, and of the keys a v3 manifest adds or revokes: only then, so a manifest whose archive fails changes nothing.
 * @param {{ source: string, dataDir: string, fetchFn?: typeof fetch, keys: (string | import('../../shared/host/updateSignature.mjs').TrustedKey)[], keyStore?: ReturnType<typeof createUpdateKeys>, hostId: string, now?: () => number, coreLoads?: (addon: string) => string }} o
 * @returns {Promise<{ version: string, sha256: string, staged: boolean }>}
 */
export async function stageUpdate({ source, dataDir, fetchFn = fetch, keys, keyStore, hostId, now = Date.now, coreLoads = addonLoads }) {
  if (keys.length === 0)
    throw new Error('This Host trusts no update key: pair the app with it, or give it one with `mopilot-host trust-update-key`.');
  const manifest = JSON.parse((await readSource(source, fetchFn, MAX_MANIFEST_BYTES)).toString('utf8'));
  const floor = readFloor(dataDir);
  const verdict = checkManifest(manifest, { keys, hostId, now: now(), floor });
  if (!verdict.ok) throw new Error(verdict.message);
  const p = updatePaths(dataDir);
  const { version, sha256 } = manifest;
  const take = () => {
    const accept = () => {
      fs.writeFileSync(p.next, JSON.stringify({ version, sha256 }));
      // nothing older than this build is taken from now on
      fs.writeFileSync(p.floor, JSON.stringify({ seq: manifest.seq, sha256 }), { mode: 0o600 });
      if (!keyStore) return;
      keyStore.markSeen(verdict.keyId);
      // only a v3 manifest signs what it says of keys; the fields of a v2 one are not the publisher's
      if (typeof manifest.keyId === 'string')
        keyStore.apply({ signedBy: verdict.keyId, nextKey: manifest.nextKey, revoke: manifest.revoke });
    };
    return keyStore ? keyStore.withCurrentTrust(manifest, { hostId, now, floor: () => readFloor(dataDir) }, accept) : accept();
  };
  if (fs.existsSync(p.version(sha256))) {
    take();
    return { version, sha256, staged: false };
  }
  // an archive named relative to a local manifest sits beside it
  const where = REMOTE.test(manifest.url) || REMOTE.test(source) ? manifest.url : path.resolve(path.dirname(source), manifest.url);
  const bytes = await readSource(where, fetchFn, MAX_ARCHIVE_BYTES);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new Error('The downloaded update does not match its checksum; it was not kept.');
  const prepareAndAccept = () => {
    // owner-only, whatever the umask: the code that runs next start is staged here
    fs.mkdirSync(path.dirname(p.blob(sha256)), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(p.version(sha256)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.blob(sha256), bytes);
    const unpacking = `${p.version(sha256)}.${process.pid}.tmp`;
    fs.rmSync(unpacking, { recursive: true, force: true });
    fs.mkdirSync(unpacking, { mode: 0o700 });
    const tar = spawnSync('tar', ['-xzf', p.blob(sha256), '--no-same-owner', '--no-same-permissions', '-C', unpacking], {
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    if (tar.status !== 0 || !fs.existsSync(path.join(unpacking, 'src', 'cli.mjs'))) {
      fs.rmSync(unpacking, { recursive: true, force: true });
      throw new Error('The update could not be unpacked, or it is not a Host version.');
    }
    const refusal = coreRefusal(unpacking, undefined, coreLoads);
    if (refusal) {
      fs.rmSync(unpacking, { recursive: true, force: true });
      fs.rmSync(p.blob(sha256), { force: true });
      throw new Error(refusal);
    }
    fs.renameSync(unpacking, p.version(sha256));
    take();
    return { version, sha256, staged: true };
  };
  return keyStore
    ? keyStore.withCurrentTrust(manifest, { hostId, now, floor: () => readFloor(dataDir) }, prepareAndAccept)
    : prepareAndAccept();
}

/**
 * The running Host's side: restart into the staged version, but only once nothing is running. Until then the Host takes no new work.
 * @param {{ dataDir: string, idle: () => boolean, restart: () => void, pollMs?: number }} o
 */
export function createUpdater({ dataDir, idle, restart, pollMs = IDLE_POLL_MS }) {
  const p = updatePaths(dataDir);
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  const updater = {
    /** Whether a restart is under way: a new send or sign-in is refused meanwhile. */
    get restarting() {
      return timer !== null;
    },
    /** Whether nothing is running: no turn, no sign-in, no install. The app asks before it updates or removes the machine. */
    isIdle: () => idle(),
    /** Ask for the restart; it happens now when idle, else as soon as the Host is. @returns {{ state: 'none' | 'restarting' | 'waiting', version?: string }} */
    request() {
      const next = readPointer(p.next);
      if (!next || !fs.existsSync(p.version(next.sha256))) return { state: 'none' };
      if (timer) return { state: 'waiting', version: next.version };
      const go = () => {
        if (!idle()) return false;
        try {
          // the staged version becomes the active one only at the moment the Host leaves
          fs.renameSync(p.next, p.active);
        } catch {
          // it cannot be activated: the Host stays up on the version it has
          updater.close();
          return false;
        }
        clearInterval(/** @type {any} */ (timer));
        restart();
        return true;
      };
      timer = setInterval(go, pollMs);
      timer.unref();
      return { state: go() ? 'restarting' : 'waiting', version: next.version };
    },
    close() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return updater;
}
