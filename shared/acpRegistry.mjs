// Validates public ACP registry metadata and converts a selected agent into a shared, admission-gated harness contract.
import { ownTable } from './ownTable.mjs';

export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/;
const NPM = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[0-9][0-9A-Za-z.+-]*)?$/;
const PYPI = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:(?:==|@)[0-9][0-9A-Za-z.+-]*)?$/;
const TARGETS = new Set(['darwin-aarch64', 'darwin-x86_64', 'linux-aarch64', 'linux-x86_64', 'windows-aarch64', 'windows-x86_64']);
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const fail = (field) => {
  throw new Error(`The ACP registry contains an invalid ${field}.`);
};

/** Registry URLs are HTTPS addresses, without embedded credentials. */
function https(value) {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** An archive command stays inside its extracted directory, on every platform. */
export function containedCommand(value) {
  return (
    text(value) &&
    !/[\\:]/.test(value) &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part && part !== '..') &&
    value !== '.'
  );
}

function launchFields(value) {
  const args = value.args ?? [];
  const env = value.env ?? {};
  if (!Array.isArray(args) || args.length > 100 || args.some((v) => typeof v !== 'string' || v.length > 65536 || v.includes('\0')))
    fail('arguments');
  if (
    !object(env) ||
    Object.entries(env).some(
      ([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.length > 65536 || v.includes('\0'),
    )
  )
    fail('environment');
  return { args: [...args], env: ownTable({ ...env }) };
}

/**
 * Read a single entry. Metadata never becomes a command until an explicit install selects its validated distribution.
 * @param {unknown} value
 */
export function registryAgent(value) {
  const v = /** @type {any} */ (value);
  if (!object(v) || !text(v.id, 100) || !ID.test(v.id)) fail('agent identity');
  if (!text(v.name, 200) || !text(v.version, 100) || !VERSION.test(v.version)) fail('agent name or version');
  if (!object(v.distribution)) fail('distribution');
  const distributions = ownTable({});
  for (const kind of ['npx', 'uvx']) {
    if (v.distribution[kind] === undefined) continue;
    const raw = v.distribution[kind];
    if (!object(raw) || !text(raw.package, 500) || !(kind === 'npx' ? NPM : PYPI).test(raw.package)) fail(`${kind} package`);
    let spec = raw.package;
    const pinned = kind === 'npx' ? /@\d/.test(spec) : /(?:==|@)\d/.test(spec);
    if (!pinned) spec += kind === 'npx' ? `@${v.version}` : `==${v.version}`;
    distributions[kind] = { package: spec, ...launchFields(raw) };
  }
  if (v.distribution.binary !== undefined) {
    if (!object(v.distribution.binary)) fail('binary distribution');
    const binary = ownTable({});
    for (const [target, raw] of Object.entries(v.distribution.binary)) {
      const b = /** @type {any} */ (raw);
      const command = typeof b?.cmd === 'string' && target.startsWith('windows-') ? b.cmd.replaceAll('\\', '/') : b?.cmd;
      if (!TARGETS.has(target) || !object(b) || !https(b.archive) || !containedCommand(command)) fail('binary target');
      if (b.sha256 !== undefined && (typeof b.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(b.sha256))) fail('binary checksum');
      binary[target] = { archive: b.archive, cmd: command, ...(b.sha256 ? { sha256: b.sha256.toLowerCase() } : {}), ...launchFields(b) };
    }
    distributions.binary = binary;
  }
  if (!Object.keys(distributions).length) fail('distribution');
  const docsUrl = v.website ?? v.repository ?? v.docsUrl ?? 'https://agentclientprotocol.com/registry';
  if (!https(docsUrl)) fail('documentation URL');
  const vendor =
    Array.isArray(v.authors) && v.authors.every((a) => text(a, 200)) && v.authors.length
      ? v.authors.join(', ')
      : text(v.vendor, 1000)
        ? v.vendor
        : 'ACP registry';
  return {
    id: v.id,
    name: v.name,
    version: v.version,
    description: text(v.description) ? v.description : '',
    docsUrl,
    vendor,
    distribution: distributions,
  };
}

/** A complete registry is adopted together; malformed or duplicate entries never partially replace a valid snapshot. */
export function registryAgents(value) {
  const v = /** @type {any} */ (value);
  if (!object(v) || !Array.isArray(v.agents) || v.agents.length > 500) fail('agent list');
  const agents = v.agents.map(registryAgent);
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length) fail('duplicate agent identity');
  return agents;
}

/** Select a launch only when its verified binary or package manager is available on the current platform. */
export function registryDistribution(agent, { platform, arch, npm = false, uv = false }) {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!os || !cpu) return null;
  const binary = agent.distribution.binary?.[`${os}-${cpu}`];
  if (binary?.sha256) return { kind: 'binary', ...binary };
  if (npm && agent.distribution.npx) return { kind: 'npx', ...agent.distribution.npx };
  if (uv && agent.distribution.uvx) return { kind: 'uvx', ...agent.distribution.uvx };
  return null;
}

/** Registry agents retain independent identities and must pass the existing runtime admission checks. */
export function registryDescriptor(agent) {
  return {
    id: `registry-${agent.id}`,
    label: `${agent.name} (ACP registry)`,
    vendor: agent.vendor,
    bins: [...new Set([agent.id, ...Object.values(agent.distribution.binary ?? {}).map((spec) => spec.cmd.split('/').pop())])],
    docsUrl: agent.docsUrl,
    enabled: true,
    registry: agent,
    install: { docs: agent.docsUrl, methods: [] },
    dataNotes: ['Uses the ACP registry distribution. Supported capabilities are checked when it starts.'],
    acp: { args: [], env: {}, privacyDefaults: [], admission: { handshakeTimeoutMs: 20000, requireResume: true } },
  };
}
