// The ACP runtime of a Host: electron/harness/acp.cjs (the same AcpHost the app runs) over this Host's data dir, with a watchdog that ends a turn whose harness goes silent.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isAuthText } from '../../shared/acpAuth.mjs';
import { acpKeyed, keyAuthMethod } from '../../shared/host/credentials.mjs';
import { createAcpModels } from './acpModels.mjs';
import { HostRefusal } from './hostFs.mjs';

const require = createRequire(import.meta.url);
const { noteIgnored } = require('../../electron/ignored.cjs');
const { AcpHost } = require('../../electron/harness/acp.cjs');
const { ItemsLog } = require('../../electron/platform/chats.cjs');
const harnessQuirks = require('../../electron/harness/quirks/index.cjs');

/** A turn that shows no progress for this long is stopped. */
const DEFAULT_PROGRESS_MS = 120_000;
/** Ended turns kept, by default, for a client that reconnects to read what happened. */
const KEEP_ENDED = 200;

/** The first executable called `name` on PATH, or null. @param {string} name @param {NodeJS.ProcessEnv} env */
export function which(name, env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // not in this dir
    }
  }
  return null;
}

/**
 * The harnesses a person defined for this Host in `<data dir>/harnesses.json`: { id: { label, bin, args?, env? } }.
 * @param {string} dataDir
 * @returns {Record<string, { label: string, bin: string, args?: string[], env?: Record<string, string> }>}
 */
export function customHarnesses(dataDir) {
  try {
    const found = JSON.parse(fs.readFileSync(path.join(dataDir, 'harnesses.json'), 'utf8'));
    for (const [id, c] of Object.entries(found)) {
      const h = /** @type {any} */ (c);
      if (harnessQuirks.quirks(id)) throw new Error(`harnesses.json: "${id}" is a built-in harness; pick another id.`);
      if (typeof h?.label !== 'string' || typeof h.bin !== 'string' || (h.args !== undefined && !Array.isArray(h.args)))
        throw new Error(`harnesses.json: "${id}" needs a label, a bin and an args array.`);
    }
    return found;
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return {};
    throw e;
  }
}

/**
 * Every ACP harness this Host can name, with its binary when installed: the ones defined for it in harnesses.json, then the built-in ones.
 * @param {{ dataDir: string, env: NodeJS.ProcessEnv }} o
 * @returns {{ id: string, bin: string | null }[]}
 */
export function acpHarnesses({ dataDir, env }) {
  const custom = customHarnesses(dataDir);
  return [...new Set([...Object.keys(custom), ...harnessQuirks.ids()])].map((id) => ({
    id,
    bin: custom[id]?.bin ?? harnessQuirks.findBin(id, (/** @type {string} */ b) => which(b, env), env),
  }));
}

/** An agent's process runs for one organization identity: a message for another waits for the running turn to end. `leases` (./credentialLease.mjs) gives an agent its organization lease in its env; a lease that changes reaches the agents' next processes, started once no turn runs. */
export const ACP_IDENTITY_BUSY =
  "This machine's agent is running another person's organization chat. This message sends when that turn ends.";

/**
 * @param {{ paths: { dataDir: string }, env?: NodeJS.ProcessEnv, progressMs?: number, keepEnded?: number, hostOptions?: object, signedIn?: ReturnType<typeof import('./signedIn.mjs').createSignedIn>, leases?: { envFor: (harness: string) => Record<string, string>, has: (harness: string) => boolean, hasOrg: (harness: string) => boolean, orgLease: (harness: string) => { identity: string } | null, onChange: (fn: (harness: string) => void) => unknown } | null }} o
 */
export function createAcpRuntime({
  leases = null,
  paths,
  env = process.env,
  progressMs = DEFAULT_PROGRESS_MS,
  keepEnded = KEEP_ENDED,
  hostOptions = {},
  signedIn,
}) {
  const custom = customHarnesses(paths.dataDir);
  /** @type {string | null} the organization identity the running agents were started for */
  let envIdentity = null;
  const items = new ItemsLog(path.join(paths.dataDir, 'threads'));
  const host = new AcpHost({
    items,
    quirks: (/** @type {string} */ id) => {
      const c = custom[id];
      return c ? { id, label: c.label, args: c.args ?? [], env: c.env ?? {} } : harnessQuirks.quirks(id);
    },
    ids: [...Object.keys(custom), ...harnessQuirks.ids()],
    resolveBin: (/** @type {string} */ id) => custom[id]?.bin ?? harnessQuirks.findBin(id, (/** @type {string} */ b) => which(b, env), env),
    env: (/** @type {string | undefined} */ harness) => {
      // the identity an agent started now runs for: another identity's message never shares its process mid-turn
      envIdentity = leases?.orgLease('acp')?.identity ?? null;
      // an agent's own lent key (Gemini's GEMINI_API_KEY) goes to that agent's process alone, never to another agent's
      return { ...env, ...leases?.envFor('acp'), ...(harness && acpKeyed(harness) ? leases?.envFor(harness) : {}) };
    },
    // a Host keeps no terminals for ACP agents yet: a terminal/create from an agent fails instead of running somewhere unseen
    pty: {
      spawn: (/** @type {string} */ _id, /** @type {any} */ _o, /** @type {any} */ cb) =>
        setImmediate(() => cb?.({ type: 'exit', code: 1 })),
      kill: () => undefined,
    },
    cwd: paths.dataDir,
    dataDir: paths.dataDir,
    ...hostOptions,
  });
  const modelCatalog = createAcpModels({
    host,
    envFor: (id) => ({ ...env, ...leases?.envFor('acp'), ...(acpKeyed(id) ? leases?.envFor(id) : {}) }),
    report: (error) => noteIgnored('read Host ACP models', error),
  });
  // an agent started with its own key lent signs in with it (the key method), not with whatever it last used on this machine (electron/harness/acp/lentKeyAuth.cjs)
  /** @type {any} */ (host).lentAuthFn = (/** @type {string} */ harness) =>
    leases && keyAuthMethod(harness) && leases.has(harness) && !leases.hasOrg(harness) ? keyAuthMethod(harness) : null;

  /** @type {Map<string, { key: string, state: 'running' | 'ended', text: string, stopReason: string | null, error: string | null, noProgress: boolean, permission: { requestId: string, options: unknown[] } | null }>} */
  const turns = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const watchdogs = new Map();
  /** @type {Map<string, number>} */
  const limits = new Map();
  /** @type {Map<string, number>} the limit a send asked for, until its turn starts */
  const pendingLimit = new Map();

  const arm = (/** @type {string} */ turnId) => {
    clearTimeout(watchdogs.get(turnId));
    const turn = turns.get(turnId);
    if (!turn || turn.state === 'ended') return;
    const timer = setTimeout(() => {
      turn.noProgress = true;
      host.cancel(turn.key);
    }, limits.get(turnId));
    timer.unref();
    watchdogs.set(turnId, timer);
  };

  /** What a turn's end says of its harness's login: a turn that ran to its end is signed in, one that failed asking for a login is not. */
  const noteSignedIn = (/** @type {{ key: string, stopReason: string | null, error: string | null }} */ turn) => {
    const id = /^acp:([^:]+):/.exec(turn.key)?.[1];
    if (!signedIn || !id) return;
    if (turn.error && isAuthText(turn.error)) signedIn.set(id, false);
    else if (!turn.error && turn.stopReason === 'end_turn') signedIn.set(id, true);
  };

  host.on('event', (/** @type {any} */ e) => {
    // the turn exists from the moment its prompt goes out, so no update can arrive before it is tracked
    if (e.kind === 'turnStart') {
      turns.set(e.turnId, { key: e.key, state: 'running', text: '', stopReason: null, error: null, noProgress: false, permission: null });
      limits.set(e.turnId, pendingLimit.get(e.key) ?? progressMs);
      arm(e.turnId);
      return;
    }
    const turn = turns.get(e.turnId);
    if (!turn) return;
    if (e.kind === 'permission') {
      // a person answers over the socket (permit); while a card waits the no-progress rule is off (the approval clock owns that wait, D6)
      clearTimeout(watchdogs.get(e.turnId));
      turn.permission = { requestId: e.requestId, options: e.options };
    } else if (e.kind === 'permissionCancelled') {
      if (turn.permission?.requestId === e.requestId) {
        turn.permission = null;
        arm(e.turnId);
      }
    } else if (e.kind === 'update') {
      arm(e.turnId);
      if (e.update?.sessionUpdate === 'agent_message_chunk') turn.text += e.update.content?.text ?? '';
    } else if (e.kind === 'turnEnd') {
      clearTimeout(watchdogs.get(e.turnId));
      watchdogs.delete(e.turnId);
      limits.delete(e.turnId);
      Object.assign(turn, { state: 'ended', stopReason: e.stopReason ?? null, error: e.error ? String(e.error.message ?? e.error) : null });
      noteSignedIn(turn);
      // only the newest ended turns are kept
      const ended = [...turns].filter(([, t]) => t.state === 'ended');
      for (const [id] of ended.slice(0, Math.max(0, ended.length - keepEnded))) turns.delete(id);
    }
  });

  const idle = () => ![...turns.values()].some((t) => t.state === 'running') && host.starting.size === 0;
  /** An agent's env is read when its process starts: a lease that changed reaches it by ending the processes between turns, never in one. */
  let restartWanted = false;
  /** @param {{ refuse?: boolean }} [o] refuse: a message about to go out (send), which another identity's running turn refuses; a lease change only notes it */
  const restartIfIdle = ({ refuse = false } = {}) => {
    if (!restartWanted) return;
    if (!idle()) {
      const now = leases?.orgLease('acp')?.identity;
      if (refuse && envIdentity && now && now !== envIdentity) throw new HostRefusal('org_identity_busy', ACP_IDENTITY_BUSY);
      return;
    }
    restartWanted = false;
    host.closeAll(true);
  };
  leases?.onChange((harness) => {
    if (harness !== 'acp' && !acpKeyed(harness)) return;
    modelCatalog.clear();
    restartWanted = true;
    restartIfIdle();
  });

  return {
    host,
    models: modelCatalog.get,
    /** Send a message; the turn runs in the Host whether or not a client stays connected. @param {{ key: string, text: string, cwd?: string, progressMs?: number, human?: boolean }} p */
    async send({ key, text, cwd, progressMs: limit, human }) {
      restartIfIdle({ refuse: true });
      if (limit) pendingLimit.set(key, limit);
      try {
        const { turnId } = await host.send(
          key,
          {
            cwd: cwd ?? paths.dataDir,
            blocks: [{ type: 'text', text }],
            display: [{ type: 'text', text, text_elements: [] }],
          },
          { human: human === true },
        );
        return { turnId };
      } finally {
        // only the send that set the limit lets go of it
        if (pendingLimit.get(key) === limit) pendingLimit.delete(key);
      }
    },
    /** Whether no turn is running and no send is still starting one. */
    idle,
    /** Answer a permission card a turn is waiting on; false when it is gone. @param {{ requestId: string, optionId?: string }} p */
    permit: ({ requestId, optionId }) => host.permission(requestId, optionId),
    /** What a turn has said and how it ended; null for a turn this Host does not know. @param {string} turnId */
    turn: (turnId) => turns.get(turnId) ?? null,
    close() {
      modelCatalog.close();
      for (const t of watchdogs.values()) clearTimeout(t);
      watchdogs.clear();
      host.closeAll();
    },
    /** Every record still queued, on disk; the Host is stopping and nothing writes them later. */
    drain: () => items.drain(),
  };
}
