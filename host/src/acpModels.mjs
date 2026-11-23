// Discovers model/effort choices from a Host ACP agent's own session, without sending a prompt, and keeps the last good list.
import { createRequire } from 'node:module';
import { createModelCache } from './claudeModels.mjs';
import { machineModels } from '../../shared/host/models.mjs';
import { selectValues } from '../../shared/acpMode.mjs';
const require = createRequire(import.meta.url);
const { AcpAgent } = require('../../electron/harness/acp/agent.cjs');
const { signInWithLentKey } = require('../../electron/harness/acp/lentKeyAuth.cjs');
const { initialModels } = require('../../electron/harness/acp/initialModels.cjs');
const { catalogOf } = require('../../electron/harness/acp/settings.cjs');

/** Model and effort config declarations share the same shape on every ACP harness. @param {any} session */
export function acpModels(session) {
  const catalog = catalogOf(session);
  const option = catalog?.configOptions?.find((o) => o.type === 'select' && o.category === 'model');
  const effort = catalog?.configOptions?.find((o) => o.type === 'select' && o.category === 'thought_level');
  const efforts = selectValues(effort).map((v) => String(v.value));
  return machineModels(
    selectValues(option).map((v) => ({
      id: String(v.value),
      name: v.name ?? String(v.value),
      // the option's own name is what the agent calls the model; the validator drops one that is only the id
      ...(typeof v.name === 'string' && v.name ? { resolvedModel: v.name } : {}),
      default: v.value === option.currentValue,
      efforts,
      defaultEffort: effort?.currentValue,
    })),
  );
}

/**
 * One cache per installed binary and harness. A credential change clears it, and disposal kills every probe.
 * @param {{ host: any, envFor: (id: string) => NodeJS.ProcessEnv, report: (e: unknown) => void, spawnFn?: unknown, probeMs?: number }} o
 */
export function createAcpModels({ host, envFor, report, spawnFn, probeMs = 8_000 }) {
  const caches = new Map();
  const active = new Set();
  let closed = false;
  let generation = 0;
  /** @param {string} id @param {string} bin */
  async function ask(id, bin) {
    const mine = generation;
    let agent;
    let ended = false;
    let timer;
    const current = () => {
      if (ended || closed || mine !== generation) throw new Error('Model discovery retired');
    };
    try {
      return await Promise.race([
        (async () => {
          const q = host.quirksOf(id);
          const env = { ...envFor(id), ...q.env };
          const ctx = { bin, env, quirks: q, dataDir: host.dataDir };
          const launch = q.launch ? await q.launch(ctx) : { args: q.args, env: {} };
          current();
          if (
            q.admission?.privacyGate &&
            !(await q.admission.privacyGate({ ...ctx, args: launch.args, env: { ...env, ...launch.env } })).ok
          )
            return [];
          current();
          agent = new AcpAgent({
            harness: id,
            command: bin,
            args: launch.args,
            env: { ...env, ...launch.env },
            cwd: host.cwd,
            spawnFn,
            onRequest: async (method) => {
              if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
              throw Object.assign(new Error('Not during model discovery'), { code: -32601 });
            },
          });
          active.add(agent);
          agent.start();
          await agent.initialize();
          current();
          await signInWithLentKey(host, id, agent, (_what, error) => report(error));
          current();
          await initialModels(agent, q, (_what, error) => report(error));
          current();
          const session = await agent.request('session/new', { cwd: host.cwd, mcpServers: [] });
          current();
          return acpModels({ ...session, models: session?.models ?? agent.initialModels });
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Model discovery timed out')), probeMs);
        }),
      ]);
    } finally {
      ended = true;
      clearTimeout(timer);
      if (agent) {
        active.delete(agent);
        agent.kill();
      }
    }
  }

  return {
    /** The latest declarations; a status never waits on an agent process. @param {string} id */
    get(id) {
      if (closed) return [];
      const bin = host.resolveBin(id);
      if (!bin) return [];
      const key = JSON.stringify([id, bin]);
      if (!caches.has(key)) caches.set(key, createModelCache({ ask: () => ask(id, bin), report }));
      return caches.get(key).get();
    },
    clear() {
      generation++;
      caches.clear();
      for (const agent of active) agent.kill();
    },
    close() {
      closed = true;
      this.clear();
    },
  };
}
