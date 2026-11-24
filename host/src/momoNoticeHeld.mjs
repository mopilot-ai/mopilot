// What a quiet rule held for the brief must be seen somewhere: when the brief is turned off, or has not been shown for days (the owner is away), the held matters move to Watching with the same reason, instead of waiting unseen for the sweep that ends old matters.

/** How long a mail may wait for a brief before it moves to Watching. */
export const HELD_MAX_MS = 2 * 86_400_000;

/**
 * @param {object} o
 * @param {{ notice: { listMatters: () => Promise<any[]>, updateMatter: (key: string, fn: (current: any) => any) => Promise<boolean> } }} o.store
 * @param {() => number} o.now
 * @param {() => boolean} o.briefOn whether the owner's brief is on
 * @param {() => number} o.recheckMs how long a Watching matter waits for its next look
 */
export function createHeldSweep({ store, now, briefOn, recheckMs }) {
  return {
    /** @returns {Promise<string[]>} the keys moved to Watching */
    async sweep() {
      /** @type {string[]} */
      const moved = [];
      for (const seen of await store.notice.listMatters()) {
        if (seen.state !== 'open' || seen.pendingDelivery !== 'quiet_rule') continue;
        if (briefOn() && now() - Date.parse(seen.updatedAt) <= HELD_MAX_MS) continue;
        const changed = await store.notice.updateMatter(seen.matterKey, (current) => {
          if (current?.state !== 'open' || current.pendingDelivery !== 'quiet_rule') return undefined;
          const { pendingDelivery: _held, ...rest } = current;
          return { ...rest, state: 'watching', nextCheck: new Date(now() + recheckMs()).toISOString() };
        });
        if (changed) moved.push(seen.matterKey);
      }
      return moved;
    },
  };
}
