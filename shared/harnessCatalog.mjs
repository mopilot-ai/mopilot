// The generated native ACP descriptors shared by the app, server flags, install UI and version checks.
import catalog from './harness-catalog.generated.json' with { type: 'json' };
import { ownTable } from './ownTable.mjs';
import { registryAgent, registryDescriptor } from './acpRegistry.mjs';

export const ACP_CATALOG = ownTable(Object.fromEntries(catalog.map((entry) => [entry.id, entry])));
export const ACP_IDS = Object.keys(ACP_CATALOG);
export const ACP_PUBLIC_IDS = ACP_IDS.filter((id) => !ACP_CATALOG[id].developer);
export const ACP_SPIKE_IDS = ACP_IDS.filter((id) => ACP_CATALOG[id].developer);

/** Installed registry agents join the same catalog in main and every window; native contracts cannot be replaced. */
export function registerRegistryAgents(agents) {
  const descriptors = agents.map((agent) => registryDescriptor(registryAgent(agent)));
  if (new Set(descriptors.map((descriptor) => descriptor.id)).size !== descriptors.length)
    throw new Error('The ACP registry contains a duplicate installed agent identity.');
  for (const descriptor of descriptors) {
    const existing = ACP_CATALOG[descriptor.id];
    if (existing && !existing.registry) throw new Error(`The ACP registry cannot replace the native ${descriptor.label} contract.`);
  }
  for (const descriptor of descriptors) {
    const added = !Object.hasOwn(ACP_CATALOG, descriptor.id);
    ACP_CATALOG[descriptor.id] = descriptor;
    if (added) {
      ACP_IDS.push(descriptor.id);
      ACP_PUBLIC_IDS.push(descriptor.id);
    }
  }
  return descriptors;
}

/** A native resume command never interpolates a session id as executable shell syntax. */
export function catalogResume(id, sessionId) {
  const prefix = ACP_CATALOG[id]?.resumePrefix;
  if (!prefix) return null;
  const value = /^[a-zA-Z0-9_./:-]+$/.test(sessionId) ? sessionId : `'${sessionId.replace(/'/g, "'\\''")}'`;
  return `${prefix} ${value}`;
}

/** Static launch defaults; code-bearing overrides remain in the harness's existing quirks module. */
export function catalogQuirks(id) {
  const entry = ACP_CATALOG[id];
  if (!entry) return null;
  return {
    label: entry.label,
    bins: entry.bins,
    ...entry.acp,
    ...(entry.instructionsFiles ? { instructionsFiles: entry.instructionsFiles } : {}),
  };
}
