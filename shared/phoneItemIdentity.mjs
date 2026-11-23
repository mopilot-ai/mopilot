// Stable phone identities shared by saved panel rows and the remote live feed.
import { turnIdentity } from './chatNotes.mjs';

/** Claude replay may group steers into different turns; native message blocks and tool ids remain session-unique. */
export function phoneItemIdentity(sourceSession, turnId, item) {
  if (typeof turnId !== 'string' || typeof item.id !== 'string') return undefined;
  const claude = typeof sourceSession === 'string' && sourceSession.startsWith('claude:');
  return JSON.stringify([
    sourceSession ?? null,
    claude ? null : turnIdentity(turnId),
    item.type,
    claude ? (item.sourceId ?? item.clientId ?? item.id) : item.id,
  ]);
}
