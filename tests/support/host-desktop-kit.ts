// Stand-ins for the Host desktop's unit tests (G8 #3903): a fake helper that records what it is asked.

export function fakeHelper() {
  const calls: { method: string; params: any }[] = [];
  let stopped = 0;
  const helper = {
    installed: true,
    running: true,
    generation: 1,
    handler: (async () => ({ ok: true })) as (method: string, params: any) => Promise<any>,
    async call(method: string, params: any) {
      calls.push({ method, params });
      return helper.handler(method, params);
    },
    stop: () => void stopped++,
  };
  return { helper, calls, stopped: () => stopped };
}
