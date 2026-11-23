// A harness's route: whether its own config sends requests to its vendor or somewhere else (a gateway such as magpie, another endpoint, a cloud), read from the files and variables shared/harnessRoutes.mjs declares. Pure; main reads the files (electron/harness/routes.cjs), the windows show the answer.

/**
 * Tools known to route harnesses, recognised by what they write. A miss only changes the label ("local
 * gateway", the endpoint's host), never whether a route is shown.
 * @type {{ id: string, label: string, providerIds: string[], ports: number[], modelPrefixes: string[] }[]}
 */
export const ROUTERS = [{ id: 'magpie', label: 'magpie', providerIds: ['magpie'], ports: [3425], modelPrefixes: ['magpie/'] }];

/**
 * @typedef {{ path: string, doc?: unknown, error?: string | null }} RouteFileState a declared file as read: its
 *   parsed contents (absent: no such file) or why it couldn't be parsed
 * @typedef {{ env: Record<string, string | undefined>, files: Record<string, RouteFileState> }} RouteDocs
 * A route's `kind` is read from the config, except `mopilot-routed`: the windows' route for Claude Code while MoPilot's
 * model router sends it to the user's own provider (src/harness/routes.ts withRouted).
 * @typedef {{ value: string, key: string, source: string }} Resolved
 * @typedef {{
 *   kind: 'direct' | 'external' | 'unknown' | 'mopilot-routed',
 *   router: { id: string, label: string } | null,
 *   label: string | null,
 *   endpoint: string | null,
 *   loopback: boolean,
 *   model: string | null,
 *   provider: string | null,
 *   cloud: string | null,
 *   catalog: string | null,
 *   reasons: ('endpoint' | 'model' | 'cloud' | 'router')[],
 *   sources: { file: string | null, key: string }[],
 *   file: string | null,
 *   error: string | null,
 *   signature: string,
 * }} HarnessRoute
 */

/** A file path from its template: '{env:NAME|fallback}' and a leading '~'. */
export function expandPath(template, env, home) {
  const out = String(template).replace(/\{env:([A-Z0-9_]+)\|([^}]*)\}/g, (_, name, fallback) => env?.[name] || fallback);
  return out === '~' || out.startsWith('~/') ? home + out.slice(1) : out;
}

/** '<source>:<path>' split at the first colon, and the path into segments at the dots outside braces. */
export function splitRef(ref) {
  const at = ref.indexOf(':');
  const source = ref.slice(0, at);
  const rest = ref.slice(at + 1);
  if (source === 'env') return { source, segments: [rest] };
  const segments = [];
  let depth = 0;
  let cur = '';
  for (const ch of rest) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === '.' && depth === 0) {
      segments.push(cur);
      cur = '';
    } else cur += ch;
  }
  segments.push(cur);
  return { source, segments };
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The raw value a reference points at, and the key it resolved to; null when any part is unset. */
function walk(ref, docs) {
  const { source, segments } = splitRef(ref);
  if (source === 'env') {
    const v = docs.env?.[segments[0]];
    return v === undefined ? null : { raw: v, key: segments[0] };
  }
  let node = docs.files[source]?.doc;
  const keys = [];
  for (const seg of segments) {
    const name = seg.startsWith('{') && seg.endsWith('}') ? resolve(seg.slice(1, -1), docs)?.value : seg;
    if (name == null || !isObject(node) || !(name in node)) return null;
    node = node[name];
    keys.push(name);
  }
  return { raw: node, key: keys.join('.') };
}

/** A reference's value as text; a precedence group selects its first defined scalar, including an empty override. */
export function resolve(ref, docs) {
  if (Array.isArray(ref)) {
    for (const candidate of ref) {
      const hit = walk(candidate, docs);
      if (hit && ['string', 'number', 'boolean'].includes(typeof hit.raw)) return resolve(candidate, docs);
    }
    return null;
  }
  const hit = walk(ref, docs);
  if (!hit || !['string', 'number', 'boolean'].includes(typeof hit.raw)) return null;
  const value = String(hit.raw).trim();
  return value ? { value, key: hit.key, source: splitRef(ref).source } : null;
}

/** The first reference in the list that has a value. */
const first = (refs, docs) => {
  for (const ref of refs ?? []) {
    const hit = resolve(ref, docs);
    if (hit) return hit;
  }
  return null;
};

/** The docs with each file's overlay (Codex's active profile) laid over its top level. */
export function withOverlays(files, docs) {
  const out = { env: docs.env, files: { ...docs.files } };
  for (const f of files) {
    const state = out.files[f.id];
    if (!f.overlay || !isObject(state?.doc)) continue;
    const over = walk(f.overlay, docs)?.raw;
    if (isObject(over)) out.files[f.id] = { ...state, doc: { ...state.doc, ...over } };
  }
  return out;
}

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\]|::1)$/i;

/** An endpoint's origin, host and port, or null when it isn't a URL. */
export function endpointOf(raw) {
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  return { origin: u.origin, host: u.hostname, port, loopback: LOOPBACK.test(u.hostname) };
}

const hostIn = (host, hosts) => (hosts ?? []).some((h) => host === h || host.endsWith(`.${h}`));

/** The known tool behind a route: by the provider id it writes, its local port or its model prefix. */
export function matchRouter({ provider, endpoint, models }, routers = ROUTERS) {
  return (
    routers.find(
      (r) =>
        (provider && r.providerIds.includes(provider.toLowerCase())) ||
        (endpoint?.loopback && r.ports.includes(endpoint.port)) ||
        models.some((m) => r.modelPrefixes.some((p) => m.toLowerCase().startsWith(p))),
    ) ?? null
  );
}

/**
 * The route a harness's config sets.
 * @param {import('./harnessRoutes.mjs').HarnessRouteInfo} info
 * @param {RouteDocs} docs
 * @returns {HarnessRoute}
 */
export function classifyRoute(info, docs, routers = ROUTERS) {
  const d = withOverlays(info.files, docs);
  // a hit from a file always has that file's state
  const fileOf = (hit) => (hit.source !== 'env' ? d.files[hit.source].path : null);
  const endpointHit = first(info.endpoint, d);
  const providerHit = first(info.provider, d);
  const modelHit = first(info.model, d);
  const tierHits = (info.models ?? []).map((r) => resolve(r, d)).filter((h) => !!h);
  const catalogHit = first(info.catalog, d);
  const cloudEntry = (info.cloud ?? []).find((c) => /^(1|true|yes|on)$/i.test(resolve(c.ref, d)?.value ?? ''));
  const cloudHit = cloudEntry ? resolve(cloudEntry.ref, d) : null;

  const endpoint = endpointHit ? endpointOf(endpointHit.value) : null;
  const models = [modelHit, ...tierHits].filter((h) => !!h).map((h) => h.value);
  const router = matchRouter({ provider: providerHit?.value ?? null, endpoint, models }, routers);
  const vendorModel = info.vendorModel ? new RegExp(info.vendorModel, 'i') : null;

  /** @type {HarnessRoute['reasons']} */
  const reasons = [];
  if (router) reasons.push('router');
  if (!info.multiProvider) {
    if (endpointHit && !(endpoint && hostIn(endpoint.host, info.vendorHosts))) reasons.push('endpoint');
    if (vendorModel && models.some((m) => !vendorModel.test(m))) reasons.push('model');
    if (cloudEntry) reasons.push('cloud');
  }
  const external = reasons.length > 0;
  const hits = external ? [providerHit, endpointHit, modelHit, ...tierHits, catalogHit, cloudHit].filter((h) => !!h) : [];
  const sources = hits.map((h) => ({ file: fileOf(h), key: h.key }));
  const broken = info.files.map((f) => d.files[f.id]).find((s) => s?.error);
  /** @type {HarnessRoute['kind']} */
  const kind = external ? 'external' : broken ? 'unknown' : 'direct';
  // the file that couldn't be read, when nothing readable shows a route
  const unknown = external ? null : broken;
  const label =
    router?.label ??
    cloudEntry?.label ??
    (reasons.includes('endpoint') ? (endpoint ? (endpoint.loopback ? 'local gateway' : endpoint.host) : 'custom endpoint') : null);
  const route = {
    kind,
    router: router ? { id: router.id, label: router.label } : null,
    label: external ? label : null,
    endpoint: external ? (endpoint?.origin ?? null) : null,
    loopback: !!(external && endpoint?.loopback),
    model: external ? (modelHit?.value ?? null) : null,
    provider: external ? (providerHit?.value ?? null) : null,
    cloud: external ? (cloudEntry?.label ?? null) : null,
    catalog: external ? (catalogHit?.value ?? null) : null,
    reasons,
    sources,
    file: sources.find((s) => s.file)?.file ?? (unknown ? unknown.path : null),
    error: unknown ? /** @type {string} */ (unknown.error) : null,
  };
  // the vendor's own model choice is not a route: changing it (the CLI's /model) doesn't make a process stale
  return {
    ...route,
    signature: JSON.stringify([kind, route.label, route.endpoint, route.provider, route.cloud, route.catalog, external ? models : []]),
  };
}
