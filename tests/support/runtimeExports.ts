// The runtime values a module exports, whether Node loads it as ES (named exports) or CommonJS (a `default` object).

/** Names of the runtime values a module carries: [] for a types-only module under either module format. */
export async function runtimeExports(load: Promise<unknown>): Promise<string[]> {
  const mod = (await load) as Record<string, unknown>;
  const cjs = mod.default && typeof mod.default === 'object' ? Object.keys(mod.default) : [];
  return [...Object.keys(mod).filter((k) => k !== 'default' && k !== 'module.exports'), ...cjs];
}
