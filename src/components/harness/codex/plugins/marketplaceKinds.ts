// Which Codex marketplaces are the user's: not ones Codex bundles, nor MoPilot's own copies of store plugins.

export const BUNDLED = new Set(['openai-bundled', 'openai-primary-runtime']);

/**
 * MoPilot's copy of a store plugin in Codex (electron/plugins/codexMirror.cjs), which the store's page lists:
 * named mopilot-<marketplace> and inside the store's folder, so a user's own "mopilot-tools" stays theirs.
 */
export const isMirrored = (marketplace: string, path?: string | null) =>
  marketplace.startsWith('mopilot-') && /[\\/]plugins[\\/]cache[\\/]/.test(path ?? '');

/** A marketplace the user added to Codex, as Settings lists them. */
export const isUserMarketplace = (m: { name: string; path?: string | null }) =>
  !!m.path && !BUNDLED.has(m.name) && !isMirrored(m.name, m.path) && !/^openai-/.test(m.name);
