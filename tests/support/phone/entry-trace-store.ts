// The launch-timings opener for the production entry test: no device storage in node.
export async function openTraceStore() {
  return { load: async () => [], save: async () => undefined };
}
