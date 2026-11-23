// Per-pair sealed-title keys in the keychain, shared with the iOS notification extension through a keychain access group.
export interface SecretPort {
  get(key: string, options: object): Promise<string | null>;
  set(key: string, value: string, options: object): Promise<void>;
  remove(key: string, options: object): Promise<void>;
}

const INDEX = 'title-key-index';
const itemKey = (pairId: string) => `title-key.${pairId}`;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Items live under one keychain service so the extension finds them by service and access group alone. SecureStore cannot list its
 * items, so an index item names them for the app (Android and iOS app code); the extension lists by service instead.
 * Writes are serialized because each one rewrites the index.
 */
export function createTitleKeys(o: { secrets: SecretPort; options: object }) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };
  async function ids(): Promise<string[]> {
    const raw = await o.secrets.get(INDEX, o.options);
    try {
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }
  return {
    save: (pairId: string, key: Uint8Array) =>
      serial(async () => {
        await o.secrets.set(itemKey(pairId), hex(key), o.options);
        const known = await ids();
        if (!known.includes(pairId)) await o.secrets.set(INDEX, JSON.stringify([...known, pairId]), o.options);
      }),
    remove: (pairId: string) =>
      serial(async () => {
        await o.secrets.remove(itemKey(pairId), o.options);
        await o.secrets.set(INDEX, JSON.stringify((await ids()).filter((id) => id !== pairId)), o.options);
      }),
    /** Every stored key; an unreadable or malformed item is skipped, never fatal. */
    all: () =>
      serial(async () => {
        const out: Uint8Array[] = [];
        for (const id of await ids()) {
          const value = await o.secrets.get(itemKey(id), o.options).catch(() => null);
          if (value && /^[0-9a-f]{64}$/.test(value))
            out.push(Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)));
        }
        return out;
      }),
    /** Drop the keys of pairs that no longer exist. */
    prune: (live: string[]) =>
      serial(async () => {
        const keep = new Set(live);
        for (const id of await ids())
          if (!keep.has(id)) {
            await o.secrets.remove(itemKey(id), o.options);
          }
        await o.secrets.set(INDEX, JSON.stringify((await ids()).filter((id) => keep.has(id))), o.options);
      }),
  };
}
