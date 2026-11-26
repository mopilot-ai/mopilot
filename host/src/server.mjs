// `serve`: the Host's foreground process. It owns a lock and a unix socket under its data dir and answers one-line JSON requests; a turn never depends on a client staying connected.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { imageReplyForWire } from './imagePublication.mjs';
import { IMAGE_METHODS } from '../../shared/host/images.mjs';
import { FOLDER_PAIRED_ONLY, parseParams } from '../../shared/host/schema.mjs';
import { HostRefusal } from './hostFs.mjs';
import { refuseByKind } from './controllerRefusals.mjs';
import { PairingError } from './pairing.mjs';
import { BROWSER_METHODS } from '../../shared/host/browser.mjs';
import { DESKTOP_METHODS } from '../../shared/host/desktop.mjs';
import { CLI_PRINCIPAL, createHostClients } from './hostClients.mjs';
import { homeStatus } from './homeGate.mjs';
import { MAX_FRAME } from '../../shared/host/frames.mjs';
import { wireError } from './protocol.mjs';
import { VERSIONED_METHOD } from './versionedMethods.mjs';
import { hostStatus } from './status.mjs';
import { ensureSocketDir } from './paths.mjs';
import { takeLock } from './hostLock.mjs';

/** The longest request line a client may send. */
const MAX_LINE = 1 << 20;
/** How much may wait unsent to one client before it is cut off: one that reads slower than the Host writes would otherwise hold the Host's memory. A client that reconnects gets the chat's log again. */
export const MAX_UNSENT = 64 * 1024 * 1024;

/** Whether two strings are equal, without telling how much of them matched. @param {string} a @param {string} b */
function same(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Where the CLI's token for a socket is kept: beside it, owner-only. @param {string} socketPath */
export const tokenPath = (socketPath) => `${socketPath}.token`;

/** Current trusted connection identity, also rechecked when an asynchronous image reply leaves the socket. */
function imageIdentity(conn, pairing) {
  if (!conn.authed || !conn.fingerprint) return null;
  if (conn.fingerprint === 'local-cli') return conn.fingerprint;
  try {
    return pairing?.knows(conn.fingerprint) ? conn.fingerprint : null;
  } catch {
    return null;
  }
}

/** How long a connection's trust is believed while the Host pushes it events. */
const TRUST_RECHECK_MS = 1000;

/** The methods that act on a chat: only a connection that proved it holds a registered key may call them. */
const PAIRED_ONLY = new Set([
  ...IMAGE_METHODS,
  ...BROWSER_METHODS,
  ...DESKTOP_METHODS,
  // the methods a feature declares in its own file say here that they are paired (shared/host/methods/)
  ...FOLDER_PAIRED_ONLY,
  'send',
  'permit',
  'turn',
  'fs.list',
  'git.clone',
  'git.worktree',
  'chat.start',
  'chat.send',
  'chat.stop',
  'chat.permit',
  'chat.answer',
  'chat.subscribe',
  'chat.prepareContinue',
  'chat.commitContinue',
  'chat.release',
  'host.login',
  'host.loginStatus',
  'host.loginCancel',
  'host.loginInput',
  'host.logout',
  'host.modelKey',
  'host.orgLease',
  'host.install',
  'host.installStatus',
  'host.installCancel',
  'host.toolsSync',
  'host.toolResult',
  'host.scheduleSync',
  'host.scheduleRuns',
  // the line protocol's own: a repository, a sign-in or an update is no more open to an unpaired connection than a chat is (the CLI proves itself with the token next to the socket)
  'update',
  'login',
  'loginStatus',
  'loginInput',
  'loginCancel',
  'git.inspect',
  // read-only views of a chat's folder (hostRead.mjs), served only with the `hostRead` feature declared
  'git.status',
  'git.diff',
  'fs.tree',
  'fs.read',
  'fs.search',
  'git.carryPlan',
  'git.carryPush',
  'git.carryApply',
  'git.carryDrop',
]);

/** A `home` client (MoMo's home on another machine) is told only of the agents a machine has, not of its policy, spend, push or network. @param {{ principal: { kind?: string } | null }} conn @param {unknown} method @param {any} result */
const reducedFor = (conn, method, result) => (conn.principal?.kind === 'home' && method === 'host.status' ? homeStatus(result) : result);

/**
 * @param {{ method?: unknown, params?: any, token?: unknown }} req
 * @param {ReturnType<typeof import('./acp.mjs').createAcpRuntime> | undefined} runtime
 * @param {ReturnType<typeof import('./login.mjs').createLogin> | undefined} login
 * @param {ReturnType<typeof import('./update.mjs').createUpdater> | undefined} updater
 * @param {string | undefined} runningVersion
 * @param {{ hostFs: ReturnType<typeof import('./hostFs.mjs').createHostFs>, hostGit: ReturnType<typeof import('./hostGit.mjs').createHostGit>, hostRead?: ReturnType<typeof import('./hostRead.mjs').createHostRead>, hostFiles?: ReturnType<typeof import('./hostFiles.mjs').createHostFiles>, hostSearch?: ReturnType<typeof import('./hostSearch.mjs').createHostSearch> } | undefined} dirs
 * @param {ReturnType<typeof import('./pairing.mjs').createPairing> | undefined} pairing
 * @param {{ homeGate?: { landing: (fingerprint: string, chatId: unknown) => (ok: boolean) => Promise<void> }, authed: boolean, fingerprint?: string | null, principal: import('./hostClients.mjs').Principal | null, socket?: net.Socket, emit: (message: object) => unknown, session?: ReturnType<ReturnType<typeof import('./protocol.mjs').createProtocol>['connection']> }} conn this connection's standing
 * @param {ReturnType<typeof import('./protocol.mjs').createProtocol> | undefined} protocol the protocol the Host serves; its `status` is the one status
 * @param {string} cliToken what the CLI on this machine proves itself with
 */
async function answer(req, runtime, login, updater, runningVersion, dirs, pairing, conn, harnesses, updateKey, protocol, cliToken) {
  try {
    // the CLI on this machine reads the token from beside the socket (callHost); whoever can read it can read the pairing too
    if (cliToken && typeof req.token === 'string' && same(req.token, cliToken)) {
      // a connection that proved a paired client's key does not become the CLI by presenting the token: a client that read it (a file, a shell) must open a connection of its own, which the Host sees as one
      if (conn.principal && conn.principal !== CLI_PRINCIPAL)
        return { error: 'This client is already paired and may not become another.', code: 'forbidden' };
      conn.authed = true;
      conn.fingerprint = 'local-cli';
      conn.principal = CLI_PRINCIPAL;
    }
    // what a kind of client may ask at all (host/src/controllerRefusals.mjs): a controller has a person's chat powers and none of the Host's own settings, a kind this Host does not know none; each refusal is a line in the audit record (coalesced)
    try {
      refuseByKind(conn.principal, String(req.method));
    } catch (error) {
      pairing?.record?.({
        kind: 'client.refused',
        by: /** @type {NonNullable<typeof conn.principal>} */ (conn.principal),
        what: { tool: String(req.method).slice(0, 64) },
      });
      throw error;
    }
    // MoMo's home on another machine reaches the versioned protocol only (where its allow-list holds it): the line protocol's files, git and sends are not for it, and it cannot pair another key
    if (conn.principal?.kind === 'home' && (!VERSIONED_METHOD.test(String(req.method)) || req.method === 'host.pair'))
      return { error: 'MoMo may not do that on this machine.', code: 'home_not_allowed' };
    if (pairing && (String(req.method).startsWith('chat.') || PAIRED_ONLY.has(String(req.method))) && !conn.authed)
      return { error: 'This client is not paired with the Host.', code: 'unknown_client' };
    // a hello that names chats the app moved away poisons this Host's copies of them: only a paired client may say so
    if (pairing && !conn.authed && req.method === 'host.hello' && req.params?.moved?.length > 0)
      return { error: 'This client is not paired with the Host.', code: 'unknown_client' };
    // once a restart is wanted the Host starts no new sign-in (the line protocol's `login` is refused below)
    if (updater?.restarting && (req.method === 'host.login' || req.method === 'host.install'))
      return { error: 'The Host is restarting for an update.' };
    // pairing rides the versioned protocol's names but not its session: it is how a connection earns the right to open one
    if (pairing && req.method === 'host.challenge') return { result: { nonce: pairing.challenge(), hostId: pairing.hostId() } };
    if (pairing && req.method === 'host.pair') {
      const result = pairing.claim(parseParams('host.pair', req.params));
      conn.authed = true;
      conn.fingerprint = result.fingerprint;
      conn.principal = result;
      return { result };
    }
    if (pairing && req.method === 'host.auth') {
      const result = pairing.verify(parseParams('host.auth', req.params));
      conn.authed = true;
      conn.fingerprint = result.fingerprint;
      conn.principal = result;
      return { result };
    }
    // the versioned protocol (shared/host/schema.mjs): hello, then chat requests with an epoch and a key
    if (conn.session && VERSIONED_METHOD.test(String(req.method))) {
      // a start of a home is told to the gate while the protocol works on it: one the protocol refuses drops its record at once (unless another start of that chat is still landing), and a removal waits for it
      const landing =
        conn.principal?.kind === 'home' && req.method === 'chat.start'
          ? conn.homeGate?.landing(conn.principal.fingerprint, req.params?.chatId)
          : undefined;
      try {
        const result = reducedFor(conn, req.method, await conn.session.call(String(req.method), req.params));
        await landing?.(true);
        return { result };
      } catch (e) {
        await landing?.(false);
        throw e;
      }
    }
    if (dirs && req.method === 'fs.list') return { result: await dirs.hostFs.list(parseParams('fs.list', req.params)) };
    // the clone's progress goes to the connection that asked, as events the client matches by key
    if (dirs && req.method === 'git.clone')
      return {
        result: await dirs.hostGit.clone(parseParams('git.clone', req.params), (key, p) => conn.emit({ event: 'progress', key, ...p })),
      };
    if (dirs?.hostFiles && req.method === 'fs.tree') return { result: await dirs.hostFiles.tree(parseParams('fs.tree', req.params)) };
    if (dirs?.hostFiles && req.method === 'fs.read') return { result: await dirs.hostFiles.read(parseParams('fs.read', req.params)) };
    if (dirs?.hostRead && req.method === 'git.diff') return { result: await dirs.hostRead.diff(parseParams('git.diff', req.params)) };
    if (dirs?.hostSearch && req.method === 'fs.search')
      return { result: await dirs.hostSearch.search(parseParams('fs.search', req.params)) };
    if (dirs?.hostRead && req.method === 'git.status') return { result: await dirs.hostRead.status(parseParams('git.status', req.params)) };
    if (dirs && req.method === 'git.inspect') {
      const query = parseParams('git.inspect', req.params);
      if (query.checkout) return { result: await dirs.hostGit.sidebarCheckout(query) };
      return { result: query.sidebar ? await dirs.hostGit.sidebarOrigin(query) : await dirs.hostGit.inspect(query) };
    }
    if (dirs && req.method === 'git.carryPush') return { result: await dirs.hostGit.carryPush(parseParams('git.carryPush', req.params)) };
    if (dirs && req.method === 'git.carryPlan') return { result: await dirs.hostGit.carryPlan(parseParams('git.carryPlan', req.params)) };
    if (dirs && req.method === 'git.carryApply')
      return { result: await dirs.hostGit.carryApply(parseParams('git.carryApply', req.params)) };
    if (dirs && req.method === 'git.carryDrop') return { result: await dirs.hostGit.carryDrop(parseParams('git.carryDrop', req.params)) };
    if (dirs && req.method === 'git.worktree') return { result: await dirs.hostGit.worktree(parseParams('git.worktree', req.params)) };
    // directories are per machine: a path from another Host means nothing here (a chat may run outside the browsing roots)
    if (dirs && runtime && req.method === 'send' && req.params?.cwd != null) await dirs.hostFs.existingDirectory(req.params.cwd);
    // one producer of the status: the protocol's, so the capabilities the app's heartbeat reads are the ones `host.status` gives
    if (req.method === 'status')
      return {
        result: protocol
          ? await protocol.status()
          : hostStatus({ running: true, runningVersion, harnesses: await harnesses?.(), updateKey }),
      };
    if (req.method === 'ping') return { result: 'pong' };
    if (req.method === 'idle' && updater) return { result: { idle: updater.isIdle() } };
    if (req.method === 'update' && updater) return { result: updater.request() };
    // once a restart is wanted the Host starts no new work
    if (updater?.restarting && (req.method === 'send' || req.method === 'login')) return { error: 'The Host is restarting for an update.' };
    if (runtime && req.method === 'send') return { result: await runtime.send(req.params ?? {}) };
    if (login && req.method === 'login') return { result: login.start(req.params ?? {}) };
    if (login && req.method === 'loginStatus') return { result: login.status(req.params?.harness) };
    if (login && req.method === 'loginInput')
      return { result: { accepted: login.input(req.params?.harness, String(req.params?.text ?? '')) } };
    if (login && req.method === 'loginCancel') return { result: login.cancel(req.params?.harness) };
    if (runtime && req.method === 'permit') return { result: runtime.permit(req.params ?? {}) };
    if (runtime && req.method === 'turn') return { result: runtime.turn(req.params?.turnId) };
    return { error: `Unknown method ${String(req.method)}.` };
  } catch (e) {
    // the versioned protocol's errors carry the codes its clients act on; the line protocol's keep their own
    if (VERSIONED_METHOD.test(String(req.method))) return wireError(e);
    return {
      error: String(e instanceof Error ? e.message : e),
      ...(e instanceof HostRefusal || e instanceof PairingError ? { code: e.code } : {}),
    };
  }
}

/**
 * @param {{ paths: { dataDir: string, socketPath: string, lockPath: string }, runtime?: ReturnType<typeof import('./acp.mjs').createAcpRuntime>, login?: ReturnType<typeof import('./login.mjs').createLogin>, updater?: ReturnType<typeof import('./update.mjs').createUpdater>, runningVersion?: string, dirs?: Parameters<typeof answer>[5], pairing?: ReturnType<typeof import('./pairing.mjs').createPairing>, protocol?: ReturnType<typeof import('./protocol.mjs').createProtocol>, harnesses?: () => Promise<{ id: string, detected: boolean, signedIn: boolean }[]>, updateKey?: boolean, afterLock?: () => Promise<unknown>, onActivity?: () => void, homeGate?: ReturnType<typeof import('./homeGate.mjs').createHomeGate> }} o `homeGate`: what a `home` client may do (told when it refuses one of its starts, and its damaged state is the owner's to repair); `onActivity` hears each request a paired client sends that is not a status look (a cloud machine's idle stop); `afterLock` runs once this Host holds the lock and before it listens: what the previous run left behind is cleaned up there
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export async function startServer({
  paths,
  runtime,
  login,
  updater,
  runningVersion,
  dirs,
  pairing,
  protocol,
  harnesses,
  updateKey,
  afterLock,
  onActivity,
  homeGate,
}) {
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.dataDir, 0o700);
  // a socket that is not in the data dir (a deep data dir) is in a folder only this user may use
  if (path.dirname(paths.socketPath) !== paths.dataDir) ensureSocketDir(path.dirname(paths.socketPath));
  await takeLock({ lockPath: paths.lockPath, socketPath: paths.socketPath });
  await afterLock?.();
  fs.rmSync(paths.socketPath, { force: true });
  // the token the CLI on this machine proves itself with: new at every start, owner-only
  const cliToken = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath(paths.socketPath), cliToken, { mode: 0o600 });
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  /** The open connections, so a client the owner removed can be told apart and cut off. @type {Set<Parameters<typeof answer>[7]>} */
  const conns = new Set();
  const clients = pairing
    ? createHostClients({
        pairing,
        homeLink: homeGate,
        connected: (fingerprint) => [...conns].some((c) => c.principal?.fingerprint === fingerprint),
        close: (fingerprint) => {
          for (const c of conns) if (c.principal?.fingerprint === fingerprint) c.socket?.destroy();
        },
      })
    : undefined;
  // what is admitted changed ("Allow connections" off): a live connection of a client kept out now is closed at once, not at its next request
  pairing?.onAdmitChange?.(() => {
    for (const c of conns) {
      const fp = c.principal?.fingerprint;
      if (fp && fp !== CLI_PRINCIPAL.fingerprint && !pairing.stillKnows(fp)) c.socket?.destroy();
    }
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    /** One message to this client, if it is still connected. @param {object} message */
    // a line over a wire frame is not sent (the other end would refuse it and drop the connection); a client far behind is cut off rather than buffered for
    // a client removed since (by any path) is cut off when the Host next has something to tell it, not only when it next asks (read at most once a second)
    let trustedAt = 0;
    const removed = () => {
      const fp = conn.principal?.fingerprint;
      if (!fp || fp === CLI_PRINCIPAL.fingerprint || !pairing?.stillKnows || Date.now() - trustedAt < TRUST_RECHECK_MS) return false;
      trustedAt = Date.now();
      return pairing.stillKnows(fp) === false;
    };
    const emit = (message) => {
      if (!socket.writable) return false;
      if (removed()) return socket.destroy(), false;
      const line = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(line) > MAX_FRAME) return false;
      if (socket.writableLength > MAX_UNSENT) return socket.destroy(), false;
      return socket.write(line);
    };
    /** @type {Parameters<typeof answer>[7]} */
    const conn = {
      authed: false,
      fingerprint: null,
      principal: null,
      socket,
      emit,
      homeGate,
    };
    conns.add(conn);
    conn.session = protocol?.connection(emit, () => imageIdentity(conn, pairing), { principal: () => conn.principal, clients });
    socket.once('close', () => (sockets.delete(socket), conns.delete(conn), conn.session?.close()));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk) => {
      buffer += chunk;
      // a paired client may send a frame (a tool result carries screenshots); before pairing a line stays small
      if (buffer.length > (conn.authed ? MAX_FRAME : MAX_LINE)) return socket.destroy();
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          socket.write(`${JSON.stringify({ id: null, error: 'Not JSON.' })}\n`);
          continue;
        }
        // trust is checked on every request, not once per connection: a client removed since (here, by the CLI, or by a signed update) is cut off before it is answered
        if (
          conn.principal &&
          conn.principal.fingerprint !== CLI_PRINCIPAL.fingerprint &&
          pairing &&
          pairing.stillKnows?.(conn.principal.fingerprint) === false
        )
          return socket.destroy();
        // a paired client that asks for more than a status look is at work (a cloud machine does not stop under it)
        if (conn.authed && req?.method !== 'status') onActivity?.();
        // a turn goes on whether or not this client is still connected to hear the answer
        void answer(req ?? {}, runtime, login, updater, runningVersion, dirs, pairing, conn, harnesses, updateKey, protocol, cliToken).then(
          (reply) => {
            if (!socket.writable) return;
            reply = imageReplyForWire(req?.method, reply);
            socket.write(`${JSON.stringify({ id: req?.id ?? null, ...reply })}\n`);
          },
        );
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // the socket is created owner-only, not created open and narrowed afterwards
      const umask = process.umask(0o077);
      server.listen(paths.socketPath, () => (process.umask(umask), resolve(undefined)));
    });
  } catch (e) {
    fs.rmSync(paths.lockPath, { force: true });
    throw e;
  }
  fs.chmodSync(paths.socketPath, 0o600);
  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          fs.rmSync(paths.socketPath, { force: true });
          fs.rmSync(tokenPath(paths.socketPath), { force: true });
          fs.rmSync(paths.lockPath, { force: true });
          resolve(undefined);
        });
        for (const socket of sockets) socket.destroy();
      }),
  };
}

/**
 * One request to a running Host: its reply ({ result } or { error }), or null when none answers on `socketPath`.
 * @param {string} socketPath @param {string} method @param {object} [params]
 * @param {{ anonymous?: boolean }} [o] `anonymous`: ask as a stranger would, without the CLI's token
 * @returns {Promise<{ result?: any, error?: string } | null>}
 */
export function callHost(socketPath, method, params, { anonymous = false } = {}) {
  // the token beside the socket, when this user can read it: the proof that this is the CLI on the Host's own machine
  let token = '';
  try {
    if (!anonymous) token = fs.readFileSync(tokenPath(socketPath), 'utf8');
  } catch {
    // no token: the Host answers what an unpaired connection may ask
  }
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => resolve(null));
    // a reply can take as long as a harness needs to start, so the connection stays open until it arrives
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, method, params, ...(token ? { token } : {}) })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.split('\n')[0]));
      } catch {
        resolve(null);
      }
    });
    // the Host hung up without answering
    socket.on('end', () => resolve(null));
  });
}

/** The result of one request to a running Host; null when none answers or the method fails. @param {string} socketPath @param {string} method @param {object} [params] */
export async function askHost(socketPath, method, params) {
  return (await callHost(socketPath, method, params))?.result ?? null;
}
