// Observable runtime factory for the production entry test.
export function createMobileRuntime(relayUrl?: string, plainRelay?: boolean, hostChat?: unknown) {
  const w = globalThis as any;
  const runtime = {
    id: ++w.__phoneRuntimeCount,
    relayUrl,
    plainRelay,
    hostChat,
    snapshot: () => ({ user: null, pairs: [] }),
    subscribe: () => () => undefined,
  };
  w.__phoneRuntimes.push(runtime);
  return runtime;
}
