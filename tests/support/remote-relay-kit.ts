// A relay client with recorded sockets, token reads and a scoped fake clock for connection tests.
import { mock } from 'node:test';
import { createRequire } from 'node:module';
import { FakeSocket } from './remoteSocket.ts';

const require = createRequire(import.meta.url);
export const R = require('../../electron/remote/relayClient.cjs');
export const { RelayClient } = R;

export function rig(o: { tokens?: (string | null | Error)[]; random?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const tokens = o.tokens ?? [];
  const asked: boolean[] = [];
  const client = new RelayClient({
    url: () => 'wss://relay.example/v1/ws',
    getToken: async (force: boolean) => {
      asked.push(force);
      const t = tokens.length ? tokens.shift()! : 'jwt-1';
      if (t instanceof Error) throw t;
      return t;
    },
    createSocket: (url: string, headers: Record<string, string>) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s as any;
    },
    random: o.random ?? (() => 1),
  });
  const states: string[] = [];
  client.on('state', (s: string) => states.push(s));
  return { client, sockets, asked, states };
}

export async function withTimers(fn: () => Promise<void>) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await fn();
  } finally {
    mock.timers.reset();
  }
}
