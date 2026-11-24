// A fake Host connection and the real app IPC registration for tool relay tests.
import { createRequire } from 'node:module';

const { register } = createRequire(import.meta.url)('../../../electron/app/ipc/host.cjs');

export function setup(live: any, dir = '/ud', rows: Record<string, any> = {}) {
  const handlers = new Map<string, any>();
  let opts: any;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined, live },
    {
      create: (o: any) => (
        (opts = o), { list: () => ({ machines: [], resolved: true }), row: (id: string) => rows[id], onRowChange: () => () => undefined }
      ),
      createFolders: () => ({}),
      allowed: () => true,
    },
  );
  // the service is made when a window first asks
  handlers.get('host:machines')!({});
  return opts;
}

export function fakeHost() {
  const sent: any[] = [];
  const events = new Set<(e: any) => void>();
  const states = new Set<(state: string) => void>();
  return {
    sent,
    events,
    states,
    host: {
      tools: {
        request: async (method: string, params: any) => (sent.push([method, params]), {}),
        onEvent: (fn: (e: any) => void) => (events.add(fn), () => void events.delete(fn)),
      },
      hostInfo: () => ({ state: 'online' }),
      onState: (fn: (state: string) => void) => (states.add(fn), () => void states.delete(fn)),
    },
  };
}
