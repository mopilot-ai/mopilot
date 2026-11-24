// The Host path without a phone or the production relay (Remote Run P6): a local relay on an in-process Postgres, a real `bin serve` Host over the fake ACP agent, and a fake phone that enrolls through the app's own relay paths and speaks the phone's Host client (shared/remote/phoneHost.mjs). `runHostPhoneScenario` is the one scenario both tests/hostPhoneEndToEnd.test.ts and scripts/host-phone-check.mjs run.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../../relay/src/config.mjs';
import { createVerifier } from '../../relay/src/auth.mjs';
import { createRelay } from '../../relay/src/server.mjs';
import { createPaths } from '../../host/src/paths.mjs';
import { helloParams } from '../../shared/host/schema.mjs';
import { createNodePrimitives } from '../../shared/remote/nodePrimitives.mjs';
import { createPhoneHost } from '../../shared/remote/phoneHost.mjs';
import { fromBase64, toBase64 } from '../../shared/remote/envelope.mjs';
import { line } from './host-line.ts';
import { makeDb, makeKeys } from './relayKit.ts';
import { waitFor } from './waitFor.ts';
import { keySafe } from './hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { createRelayPaths } = require('../../electron/host/relayPaths.cjs');
const { loadIdentity, pairWith, authenticate } = require('../../electron/host/pairingClient.cjs');

const ROOT = path.join(import.meta.dirname, '..', '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const HOST_BIN = path.join(ROOT, 'host/bin/mopilot-host.mjs');
/** The DER prefix of an Ed25519 public key (the Host registers a client by its base64 SPKI). */
const ED_SPKI = Uint8Array.of(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00);

export const CHAT = 'acp:fake:phone';

/** A relay on this machine: the real server, an in-process database, a signer for account tokens. */
export async function startRelayRig() {
  const keys = await makeKeys();
  const { db, reset } = await makeDb();
  await reset();
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
  const relay = createRelay({
    config,
    db: db as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const port = await relay.listen(0, '127.0.0.1');
  return { url: `ws://127.0.0.1:${port}/v1/ws`, keys, db, close: () => relay.close() };
}

/** A Host process (`bin serve`) whose only harness is the fake ACP agent; the app that paired with it is an identity this rig holds. */
export async function startFakeHost(base: string) {
  const dir = fs.mkdtempSync(path.join(base, 'host-'));
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: { label: 'Fake', bin: process.execPath, args: [AGENT], env: { FAKE_ACP_STATE: path.join(dir, 'agent-state') } },
    }),
  );
  const child: ChildProcess = spawn(process.execPath, [HOST_BIN, 'serve', '--data-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  let printed = '';
  child.stdout!.on('data', (c) => (printed += c));
  child.stderr!.on('data', (c) => (printed += c));
  const code = await waitFor(() => /Pairing code: (\S+)/.exec(printed)?.[1], 'the Host to print its pairing code', { timeoutMs: 20_000 });
  const paths = createPaths({ dataDir: dir, env: {} });
  const app = loadIdentity(path.join(base, `app-${path.basename(dir)}.json`), keySafe);
  const first = line(paths.socketPath);
  await pairWith(first.request, app, code);
  first.close();
  const lines = new Set<ReturnType<typeof line>>();
  /** A new authenticated connection of the app (the Mac app, which the scenario later kills). */
  const connect = async () => {
    const c = line(paths.socketPath);
    await authenticate(c.request, app);
    await c.request('host.hello', helloParams());
    lines.add(c);
    return c;
  };
  return {
    dir,
    socketPath: paths.socketPath,
    hostKey: () => fs.readFileSync(path.join(paths.configDir, 'host-id'), 'utf8').trim(),
    connect,
    /** The app goes away: every connection it held is dropped. */
    killApp: () => (lines.forEach((c) => c.close()), lines.clear()),
    async stop() {
      lines.forEach((c) => c.close());
      child.kill('SIGTERM');
      await exited;
    },
  };
}

/** A fake phone: a phone-kind account token on the relay's Host lane, the app's own enrollment code (relayPaths) and the phone's Host client. */
export async function startFakePhone({
  relay,
  host,
  base,
  device = 'ph1',
}: {
  relay: Awaited<ReturnType<typeof startRelayRig>>;
  host: Awaited<ReturnType<typeof startFakeHost>>;
  base: string;
  device?: string;
}) {
  const prim = createNodePrimitives();
  const identity = prim.edKeypair();
  // the paths file is sealed by the platform's store in the app: here the fake keeps what it was given, to read the root
  let kept = '';
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => ((kept = s), Buffer.from(`x${s}`)),
    decryptString: (b: Buffer) => b.toString().slice(1),
  };
  const paths = createRelayPaths({
    dir: fs.mkdtempSync(path.join(base, 'phone-')),
    url: () => relay.url,
    getToken: () => relay.keys.sign('u1', device, { kind: 'phone' }),
    safeStorage,
  });
  // the phone's own key is registered through the app's paired connection (host.clientAdd); the enrollment is the phone's own (host.relayEnroll)
  const app = await host.connect();
  await app.request('host.clientAdd', {
    publicKey: toBase64(Uint8Array.of(...ED_SPKI, ...identity.pk)),
    kind: 'phone',
    name: 'Fake phone',
  });
  const { hostId } = await paths.enroll('machine', (method: string, params?: object) => app.request(method, params));
  const enrollment = JSON.parse(kept).enrollments.machine;
  const states: string[] = [];
  const phone = createPhoneHost({
    prim,
    enrollment: { root: fromBase64(enrollment.root), pairId: enrollment.pairId, hostKey: host.hostKey() },
    identity,
    send: (f: any) => paths.lane.send(f),
    onState: (s: string) => states.push(s),
    onEvent: () => undefined,
  });
  paths.lane.route(enrollment.pairId, { onFrame: (f: any) => phone.handleFrame(f), onPeer: () => undefined });
  return {
    phone,
    hostId,
    pairId: enrollment.pairId as string,
    states,
    /** Whether the Host is connected to the relay on this phone's pair. */
    hostOnline: () => paths.lane.peerOnline(enrollment.pairId),
    close() {
      phone.close();
      paths.dispose();
    },
  };
}

/**
 * The whole path once: Host up, the phone enrolled, the app killed, a fake agent raising a card, the phone answering through the relay, the agent
 * continuing. Returns each step's time (ms since the start) and what the agent said, so a caller can print or assert.
 */
export async function runHostPhoneScenario(base: string) {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (step: string) => (timings[step] = Date.now() - t0);
  const relay = await startRelayRig();
  const host = await startFakeHost(base);
  let fake: Awaited<ReturnType<typeof startFakePhone>> | undefined;
  try {
    mark('hostUp');
    const phoneRig = await startFakePhone({ relay, host, base });
    fake = phoneRig;
    mark('phoneEnrolled');
    // the agent raises a card on a turn the app started, then the app is killed: nothing is left that could answer but the phone
    const app = await host.connect();
    const sent: any = await app.request('send', { key: CHAT, text: 'PERMIT it', cwd: path.dirname(host.dir) });
    host.killApp();
    mark('appKilled');
    await waitFor(() => phoneRig.hostOnline(), 'the Host on the relay', { timeoutMs: 20_000 });
    await phoneRig.phone.connect();
    mark('phoneConnected');
    const card = await waitFor(async () => (await phoneRig.phone.pending()).cards?.[0], 'the card on the phone', { timeoutMs: 20_000 });
    mark('cardSeen');
    const answered: any = await phoneRig.phone.answer({
      chatId: card.chatId,
      epoch: card.epoch,
      requestId: card.requestId,
      optionId: card.options.find((o: any) => o.kind === 'allow').optionId,
      key: `phone-key-${String(Date.now()).padStart(12, '0')}`,
    });
    mark('answered');
    // a client that was never the app reads the turn: the agent went on after the phone's answer
    const watcher = await host.connect();
    const turn: any = await waitFor(
      async () => {
        const t: any = await watcher.request('turn', { turnId: sent.turnId });
        return t?.state === 'ended' && t;
      },
      'the agent to continue and end its turn',
      { timeoutMs: 20_000 },
    );
    mark('agentContinued');
    const left = (await phoneRig.phone.pending()).cards ?? [];
    return { answered, turn, left, timings, close };
  } catch (e) {
    await close();
    throw e;
  }
  async function close() {
    fake?.close();
    await host.stop();
    await relay.close();
  }
}
