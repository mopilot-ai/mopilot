// The update channel Settings shows: the same rule the main process applies (electron/updates/channel.cjs).
export type UpdateChannel = 'stable' | 'beta' | 'dogfood';

/** Dogfood only for an internal account; anyone else who picked it follows beta. */
export function channelChoice(pref: string | null | undefined, internal: boolean): UpdateChannel {
  if (pref === 'dogfood') return internal ? 'dogfood' : 'beta';
  return pref === 'beta' ? 'beta' : 'stable';
}
