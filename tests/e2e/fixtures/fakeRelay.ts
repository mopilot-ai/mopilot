// A stand-in for the account service and the relay, so the app's Mobile Remote gets as far as a real pairing: it answers the token calls, says hello, accepts a pair, and has a phone of real crypto that can scan the code.
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createNodePrimitives } from '../../../shared/remote/nodePrimitives.mjs';
import { createPhonePairing } from '../../../shared/remote/phonePairing.mjs';

/** A port of its own for this worker: the app's environment is fixed before the test runs. */
export function fakeRelayPort(workerIndex: number) {
  return 39400 + workerIndex;
}

export async function startFakeRelay(port: number) {
  const json = (body: object) => JSON.stringify(body);
  const url = `ws://127.0.0.1:${port}/v1/ws`;
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/desktop/token') return void res.end(json({ access_token: 'access', refresh_token: 'refresh', expires_in: 900 }));
    if (req.url === '/api/desktop/relay-token') return void res.end(json({ token: 'relay', expires_in: 900 }));
    res.statusCode = 404;
    res.end('{}');
  });
  let mac: WebSocket | null = null;
  const pairs = new Map<string, boolean>();
  const relay = new WebSocketServer({ server, path: '/v1/ws' });
  relay.on('connection', (socket) => {
    mac = socket;
    socket.send(
      json({
        t: 'hello',
        device: 'test-device',
        kind: 'mac',
        peerEvents: true,
        pairs: [...pairs].map(([pair, peerOnline]) => ({ pair, peerOnline, role: 'mac', joined: true })),
      }),
    );
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.rid) socket.send(json({ t: 'ok', op: message.t, pair: message.pair, rid: message.rid }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    /** A phone scans the code: its hello reaches the Mac, and this answers with the number the phone would show. */
    async scan(qr: string, name: string) {
      const prim = createNodePrimitives();
      const sk = prim.randomBytes(32);
      const identity = { phoneId: 'ph_e2e_phone', x: { pk: prim.x25519Base(sk), sk }, ed: prim.edKeypair() };
      let pending: unknown = null;
      const store = {
        getIdentity: async () => identity,
        getPending: async () => pending,
        claimPending: async (p: unknown) => ((pending = p), true),
        markJoining: async () => undefined,
        clearPrepared: async () => void (pending = null),
        clearRefused: async () => void (pending = null),
        savePair: async () => void (pending = null),
      };
      const transport = {
        join: async (_relay: string, pair: string) => {
          pairs.set(pair, true);
          mac?.send(json({ t: 'event', ev: 'pair.joined', pair }));
        },
        send: async (frame: object) => void mac?.send(json({ t: 'frame', ...frame })),
      };
      const phone = createPhonePairing({ prim, store, transport, relayUrl: url, plainRelay: true } as never);
      return (await phone.begin(qr, name)) as { safetyNumber: string };
    },
    /** A phone backgrounding or returning changes presence without deleting its saved pairing. */
    phoneOnline(online: boolean) {
      for (const pair of pairs.keys()) {
        pairs.set(pair, online);
        mac?.send(json({ t: 'event', ev: 'peer', pair, online }));
      }
    },
    async stop() {
      for (const socket of relay.clients) socket.terminate();
      relay.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
