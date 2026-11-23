// Whether an ACP agent on this Host asks for no sign-in: its `initialize` lists no authMethods, or lists some but starts a session without one and reports usable models (opencode on its free models); and its quirks name no setup it still needs (a provider key). An agent that does need a login is told with the methods it lists. The answer is cached per binary, so `status` every 30 seconds starts the agent once, not each time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { acpModels } from './acpModels.mjs';

const require = createRequire(import.meta.url);
const { AcpAgent } = require('../../electron/harness/acp/agent.cjs');
const { initialModels } = require('../../electron/harness/acp/initialModels.cjs');
const harnessQuirks = require('../../electron/harness/quirks/index.cjs');
const { noteIgnored } = require('../../electron/ignored.cjs');

/** How long an agent may take to answer initialize before it counts as needing a sign-in. */
const PROBE_MS = 15_000;
/** How long an answer is kept: an upgrade that adds a login method shows up within this. */
const KEEP_MS = 10 * 60_000;
/** How long a probe that did not answer (a slow start, a hung agent, an agent that failed to start) is kept: a slow first start must not read as "signed out" for ten minutes. */
const RETRY_MS = 30_000;

/**
 * @param {{ env: NodeJS.ProcessEnv, now?: () => number, spawnFn?: unknown, probeMs?: number, quirksOf?: (id: string) => any }} o
 */
export function createNoSignIn({ env, now = Date.now, spawnFn, probeMs = PROBE_MS, quirksOf = harnessQuirks.quirks }) {
  /** @type {Map<string, { at: number, ttl: number, answer: Promise<{ ready: boolean, methods: string[], checking?: true }> }>} */
  const cache = new Map();

  /** @param {string} id @param {string} bin */
  async function probe(id, bin) {
    const q = quirksOf(id);
    // a harness that needs a key or a model before it runs is set up by a person, never by this guess
    if (!q || q.setup) return { ready: false, methods: [], answered: true };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-host-auth-'));
    /** @type {() => void} */
    let stop = () => undefined;
    const run = async () => {
      const ctx = { bin, env: { ...env, ...q.env }, quirks: q, dataDir: cwd };
      const launch = q.launch ? await q.launch(ctx) : { args: q.args, env: {} };
      if (q.admission.privacyGate && !(await q.admission.privacyGate({ ...ctx, args: launch.args, env: { ...ctx.env, ...launch.env } })).ok)
        return { ready: false, methods: [], answered: true };
      const agent = new AcpAgent({
        harness: id,
        command: bin,
        args: launch.args,
        env: { ...ctx.env, ...launch.env },
        cwd,
        spawnFn,
        onRequest: async () => {
          throw Object.assign(new Error('not during a probe'), { code: -32601 });
        },
      });
      stop = () => agent.kill();
      agent.start();
      let timer;
      return await Promise.race([
        (async () => {
          await agent.initialize();
          const caps = /** @type {NonNullable<typeof agent.caps>} */ (agent.caps);
          const methods = caps.authMethods.map((/** @type {any} */ m) => String(m?.name ?? m?.id ?? '')).filter(Boolean);
          if (caps.authMethods.length === 0) return { ready: true, methods: [], answered: true };
          // an agent that lists a login can still run with none: it starts a session without `authenticate` and reports models
          await initialModels(agent, q, () => undefined);
          const session = await agent.request('session/new', { cwd, mcpServers: [] }).catch(() => null);
          const models = session ? acpModels({ ...session, models: session.models ?? agent.initialModels }) : [];
          return { ready: models.length > 0, methods, answered: true };
        })(),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('no answer')), probeMs))),
      ]).finally(() => clearTimeout(timer));
    };
    // it did not start, or did not speak ACP: not ready to be called signed in
    const started = now();
    const found = await run().catch((/** @type {unknown} */ error) => {
      // the Host's log says why an agent did not answer, and how long it took
      noteIgnored(`probe whether ${id} runs without a sign-in (${now() - started} ms)`, error);
      return { ready: false, methods: /** @type {string[]} */ ([]), answered: false };
    });
    stop();
    fs.rmSync(cwd, { recursive: true, force: true });
    return found;
  }

  return {
    /** Whether the agent at `bin` runs without a sign-in, and the login methods it lists. @param {string} id @param {string} bin */
    inspect(id, bin) {
      const key = `${id}\0${bin}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < hit.ttl) return hit.answer;
      /** @type {{ at: number, ttl: number, answer: Promise<{ ready: boolean, methods: string[], checking?: true }> }} */
      const entry = {
        at: now(),
        ttl: KEEP_MS,
        // an answer is kept ten minutes; a probe that did not answer is asked again soon
        answer: probe(id, bin).then(({ ready, methods, answered }) => {
          if (!answered) entry.ttl = RETRY_MS;
          // a probe that did not answer yet is not "signed out": the row says the Host is still checking
          return { ready, methods, ...(answered ? {} : { checking: /** @type {true} */ (true) }) };
        }),
      };
      cache.set(key, entry);
      return entry.answer;
    },
    /** Whether the agent at `bin` asks for no sign-in. @param {string} id @param {string} bin */
    async check(id, bin) {
      return (await this.inspect(id, bin)).ready;
    },
  };
}
