// A sealed chat cache on a map and a stand-in cipher that binds the aad as the real AEAD does: what the chat-cache tests write and read back.
const sealedPath = '../../../mobile/src/presentation/chatCache';
const { createChatCache } = await import(sealedPath);

export function fakeCache() {
  const disk = new Map<string, string>();
  const order: string[] = [];
  const touch = (k: string) => (order.includes(k) && order.splice(order.indexOf(k), 1), order.push(k));
  const store = {
    read: async (k: string) => disk.get(k) ?? null,
    write: async (k: string, v: string) => (disk.set(k, v), touch(k), undefined),
    remove: async (k: string) => (disk.delete(k), order.includes(k) && order.splice(order.indexOf(k), 1), undefined),
    keys: async () => [...order],
    clear: async () => (disk.clear(), order.splice(0), undefined),
  };
  const crypto = {
    key: async () => new Uint8Array([7]),
    randomBytes: (n: number) => new Uint8Array(n).fill(3),
    // a stand-in cipher that binds the aad, as the real AEAD does
    seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
      new TextEncoder().encode(`${aad}\u0000${new TextDecoder().decode(plain)}`),
    open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
      const text = new TextDecoder().decode(box);
      return text.startsWith(`${aad}\u0000`) ? new TextEncoder().encode(text.slice(aad.length + 1)) : null;
    },
  };
  const cache = createChatCache({ store, crypto });
  return { cache: Object.assign(cache, { __store: store, __crypto: crypto }), disk };
}
