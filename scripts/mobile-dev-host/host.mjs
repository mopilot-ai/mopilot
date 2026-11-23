// DEV ONLY: the Mac side of Mobile Remote without MoPilot. The real relay, the real sealed channel, pairing and RemoteService run in this Node process over a small fake of the app (fakeApp.mjs); a phone on the same network pairs and drives it. It listens on the LAN with no TLS and approves every sign-in (account.mjs), so use it only on a network you trust.
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import WebSocket from 'ws';
import http2 from 'node:http2';
import { loadConfig } from '../../relay/src/config.mjs';
import { describePush, pushEnv } from './pushEnv.mjs';
import { createVerifier } from '../../relay/src/auth.mjs';
import { createRelay } from '../../relay/src/server.mjs';
import { createSender } from '../../relay/src/pushSenders.mjs';
import { Metrics } from '../../relay/src/metrics.mjs';
import { DurableStore, migrateDurable } from '../../relay/src/durableStore.mjs';
import { migrate } from '../../relay/src/schema.mjs';
import { createAccountService, USER } from './account.mjs';
import { createFakeApp, GONE } from './fakeApp.mjs';
import { createFakeHosts } from './fakeHosts.mjs';
import { hostSeesRelay } from './format.mjs';
import { createPty } from './pty.mjs';
import { ensureRepo } from './repo.mjs';
import { scratchDir, scratchSafeStorage } from './scratch.mjs';
import { eventLine, explainEvent, explainRequest, line, replyLine, requestLine } from './format.mjs';
import { createControls } from './controls.mjs';
import { createFakeMomo, MAIN_CHAT, voiceOps } from './fakeMomo.mjs';
import { createFakeSuggestions } from './fakeMomoSuggestions.mjs';
import { createFakeBrief } from './fakeMomoBrief.mjs';
import { createScenarios } from './scenarios.mjs';
import { advanceTx } from './gap.mjs';
import { withMomoShell } from './scenariosMomoShell.mjs';
import { withMomoChannels } from './scenariosMomoChannels.mjs';
import { createFakeChannels } from './fakeMomoChannels.mjs';
import { withLateEcho, withMomoEcho } from './scenariosMomoEcho.mjs';

const require = createRequire(import.meta.url);
const { openRemote } = require('../../electron/remote/runtime.cjs');
const { RemoteService } = require('../../electron/remote/service.cjs');
const { gateRemote } = require('../../electron/remote/gate.cjs');
const { createReviewOps } = require('../../electron/remote/review/ops.cjs');
const { messageOf } = require('../../electron/ignored.cjs');

export const MAC_ID = 'mac-dev-host';

/** Whether a Bearer token names a phone (the relay's own check verifies it; this only tells phones from the Mac for a bench outage). */
function isPhoneToken(/** @type {string | undefined} */ header) {
  try {
    return JSON.parse(Buffer.from(String(header).split('.')[1], 'base64url').toString()).dk === 'phone';
  } catch {
    return false;
  }
}

/** Fails with a plain reason when something already listens there. */
function assertPortFree(/** @type {number} */ port, /** @type {string} */ bind) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) =>
      reject(new Error(`Cannot listen on ${bind}:${port} (${/** @type {any} */ (error).code}); is another dev host running?`)),
    );
    probe.listen(port, bind, () => probe.close(() => resolve(undefined)));
  });
}

/**
 * @param {object} o
 * @param {string} o.dir scratch folder: account key, sealed Mac identity, relay database, the git repository
 * @param {string} o.advertise host or IP the phone reaches this Mac at (goes into the QR and the sign-in URLs)
 * @param {number} [o.port] 0 picks a free port
 * @param {string} [o.bind] interface to listen on (default all, for the phone)
 * @param {(text: string) => void} [o.out] one log line at a time
 * @param {(req: { device: { id: string, name: string }, safetyNumber: string, signal: AbortSignal }) => Promise<'allow' | 'deny' | null>} [o.confirm] default: allow, after logging the number
 * @param {boolean} [o.mirrors] whether terminal and screen mirrors are on for every device (default on)
 * @param {boolean} [o.uninvited] the account has no Mobile Remote invite (default: it has)
 * @param {{ id: string, email?: string }} [o.qrAccount] the account the pairing QR names (`acct`, `who`), for the phone's "a computer on another account" card; default: the QR names none, as before
 * @param {boolean} [o.fakeHosts] the account has Host, with two made-up machines (fakeHosts.mjs; default off)
 * @param {Parameters<typeof createFakeApp>[0]['sleep']} [o.sleep]
 * @param {Record<string, string | undefined>} [o.env] where the relay's push settings (PUSH_MODE, APNS_*, FCM_*) are read from (default: the process environment)
 * @param {() => number} [o.now]
 * @param {number} [o.readyMs] how long the Mac may take to reach its own relay (default 10 s)
 * @param {Parameters<typeof createFakeHosts>[0]['real']} [o.realHost] a real Host (realHost.mjs) among the machines; stopped with the host unless it is kept
 * @param {Parameters<typeof createPty>[0]} [o.ptyOptions] the terminal's seams, for tests
 * @param {(authority: string) => import('node:http2').ClientHttp2Session} [o.pushConnect] how the push sender reaches APNs, for tests (a local HTTP/2 server)
 */
export async function startHost({
  dir,
  advertise,
  port = 8787,
  bind = '0.0.0.0',
  out = console.log,
  confirm,
  mirrors = true,
  fakeHosts = false,
  realHost = null,
  uninvited = false,
  qrAccount,
  sleep,
  env = process.env,
  now = Date.now,
  readyMs = 10_000,
  ptyOptions,
  pushConnect = http2.connect,
}) {
  const log = (/** @type {string} */ text) => out(line(now(), text));
  scratchDir(dir);
  // a second host on the same port would open (and migrate) the running host's database before failing to listen
  await assertPortFree(port, bind);
  const account = await createAccountService({ dir, invited: !uninvited, host: fakeHosts || realHost !== null });
  const repo = ensureRepo(dir);

  /** @type {PGlite | null} */
  let db = null;
  /** @type {ReturnType<typeof createRelay> | null} */
  let relay = null;
  /** @type {ReturnType<typeof openRemote> | null} */
  let remote = null;
  /** @type {ReturnType<typeof createPty> | null} */
  let shells = null;
  /** @type {Promise<void> | null} */
  let stopping = null;
  let stopped = false;
  let restartBusy = false;
  /** @type {Promise<void> | null} the relay restart under way */
  let restarting = null;
  /** The Mac's reconnects are refused until then (a scenario's network outage). */
  let macBlockedUntil = 0;
  /** The HTTP/2 sessions the push sender opened to APNs; a session that stays open keeps the process alive after stop. */
  const pushSessions = new Set();
  /** Stops serving: shells, the Mac side, the relay and its database, in that order. Safe to call twice (the second call waits for the first). */
  const stop = () =>
    (stopping ??= (async () => {
      stopped = true;
      shells?.killAll();
      remote?.close();
      try {
        // a restart that is waiting to bring the relay back sees that the host is stopping and does not
        await Promise.allSettled([restarting]);
        await relay?.close();
        // the relay records each closed connection (presence) in the database; let those writes land before it closes
        for (let i = 0; i < 3; i++) {
          await Promise.all([...(relay?.hub.conns.values() ?? [])].map((c) => c.queue));
          await new Promise((r) => setImmediate(r));
        }
      } finally {
        for (const session of pushSessions) session.close();
        await db?.close();
      }
    })());
  try {
    // the relay: the same server, durable mailbox and verifier the deployed one runs, over an on-disk Postgres
    const store = new PGlite(path.join(dir, 'relay-db'));
    db = store;
    await migrate(/** @type {any} */ (store));
    await migrateDurable(store);
    const config = loadConfig({ AUTH_PUBLIC_KEY: account.publicPem, DATABASE_URL: 'postgres://unused', ...pushEnv(env) });
    log(`relay: ${describePush(config.push)}`);
    // the sender the deployed relay builds from the same settings (null with PUSH_MODE=none), shared by every restart of the relay so its failure guard keeps its state
    const metrics = new Metrics();
    const send = createSender(config.push, {
      log: (event, data) => log(`relay: ${event} ${JSON.stringify(data)}`),
      metrics,
      connect: (authority) => {
        const session = pushConnect(authority);
        pushSessions.add(session);
        session.on('close', () => pushSessions.delete(session));
        return session;
      },
    });
    /** A relay over the one database: the same server every time, so a restart keeps the mailbox. */
    const makeRelay = () => {
      const made = createRelay({
        config,
        db: /** @type {any} */ (store),
        verifier: createVerifier(config.auth),
        send,
        metrics,
        log: (event, data) => log(`relay: ${event} ${JSON.stringify(data)}`),
        durable: new DurableStore((fn) => store.transaction(fn)),
      });
      // the account routes share the relay's port, so the phone needs one address
      const [original] = made.server.listeners('request');
      made.server.removeAllListeners('request');
      made.server.on('request', (req, res) => {
        try {
          new URL(String(req.url), 'http://host');
        } catch {
          return void res.writeHead(400).end();
        }
        if (account.handle(req, res)) return void log(`account: ${req.method} ${String(req.url).split('?')[0]}`);
        Promise.resolve(original(req, res)).catch(() => res.headersSent || res.writeHead(500).end());
      });
      // a Mac cut off the network is refused at the door; phones (tokens marked dk: phone) are not
      const [upgrade] = made.server.listeners('upgrade');
      made.server.removeAllListeners('upgrade');
      made.server.on('upgrade', (req, socket, head) => {
        if (Date.now() < macBlockedUntil && !isPhoneToken(req.headers.authorization)) return void socket.destroy();
        upgrade(req, socket, head);
      });
      return made;
    };
    const server = makeRelay();
    relay = server;
    const listening = await server.listen(port, bind);
    const origin = `${advertise}:${listening}`;
    const relayUrl = `ws://${origin}/v1/ws`;

    // the app underneath: real service and feed, made-up chats
    const terminals = createPty({
      ...ptyOptions,
      onRepair: (helper) => log(`terminal: gave node-pty's spawn-helper its execute bit (${helper})`),
      onFallback: (why) => log(`terminal: node-pty could not start a shell (${why}); using plain pipes`),
    });
    shells = terminals;
    // MOPILOT_DEV_HOST_LATENCY_MS: how long each call of a chat's controls takes, to stand in for a relay round trip when timing the phone
    const app = createFakeApp({
      repo,
      log,
      now,
      sleep,
      latency: Number(process.env.MOPILOT_DEV_HOST_LATENCY_MS) || 0,
      refuseSwitch: process.env.MOPILOT_DEV_HOST_REFUSE_SWITCH ?? '',
    });
    // --fake-hosts: the account has Host and two machines a phone can start on, move to and see come and go
    const hosts = fakeHosts || realHost ? createFakeHosts({ app, log, now, real: realHost }) : null;
    const review = createReviewOps({
      // every chat works in the one repository (a phone reaches a chat only after following it, which needs the chat to exist)
      cwdOf: async () => repo,
      live: { chats: { records: app.chats }, controller: {} },
      history: async () => ({ turns: [] }),
    });
    const mirror = {
      folderOf: async () => repo,
      approveTerminal: async (/** @type {string} */ id, /** @type {{ cwd: string }} */ { cwd }) => (
        log(`app: terminal in ${cwd} allowed for ${id}`), true
      ),
      pty: terminals,
      tool: { running: () => null, onChange: () => () => undefined },
    };
    /** @type {import('./controls.mjs').Bench} */
    const bench = { momo: false, brain: false, tasks: true, shell: false, voice: 'on', pushBody: false, suggestions: 'on', brief: 'off' };
    /** @type {any} */
    let momoFake = null;
    /** @type {any} */
    let fakeChannels = null;
    const service = new RemoteService({
      ops: { ...app.ops, review, mirror, dictation: voiceOps(app.ops.dictation, () => bench.voice) },
      goneText: GONE,
      // an older Mac does not list the Tasks or the voice method: the scenarios `momo-tasks off` and `momo-voice off` hide them from the hello and refuse them
      policy: {
        mirrors: () => mirrors,
        allow: (/** @type {string} */ _pair, /** @type {string} */ method) =>
          (!['momo.tasks.list', 'momo.tasks.mark'].includes(method) || bench.tasks) &&
          (!method.startsWith('momo.suggestions.') || bench.suggestions !== 'off') &&
          (method !== 'momo.brief.runNow' || bench.brief !== 'off') &&
          (!method.startsWith('momo.channels.') || bench.channels !== false) &&
          (method !== 'momo.chat.transcribe' || bench.voice !== 'off'),
      },
      // MoMo is off until a scenario turns it on, as for an account that was never invited
      momoAllowed: () => bench.momo,
      momo: () => momoFake,
      ...(hosts && { host: () => hosts }),
      version: 'dev-host',
    });
    app.bind(service);
    fakeChannels = createFakeChannels({
      app,
      enabled: () => bench.channels !== false,
      changed: (area) => service.onMomoChanged(area),
      now,
    });
    momoFake = withLateEcho(
      createFakeMomo({
        app,
        channels: fakeChannels,
        brainChangeAllowed: () => bench.brain,
        changed: (area) => service.onMomoChanged(area),
        now,
        // the four-tab Tasks panel is what a Mac that lists the method answers; `momo-tasks failed` makes its read fail
        tasksPanel: () => true,
        tasksFailing: () => bench.tasksFailed === true,
        // the page shell is what `momo-shell on` turns on, as the Mac's `momo.shell` flag does
        shell: () => bench.shell === true,
        tasksEmpty: () => bench.tasksEmpty === true,
        brief: () => momoFake?.brief?.row() ?? null,
        suggestions: () => bench.suggestions !== 'off',
      }),
      bench,
    );
    let startN = 0;
    // MoMo's suggestions (momo-suggestions): the Mac's own store over made-up ones; Start sends the first step into MoMo's fake chat
    momoFake.suggestions = createFakeSuggestions({
      now,
      changed: (/** @type {'memory'} */ area) => service.onMomoChanged(area),
      send: async (/** @type {string} */ text) => momoFake.send(await momoFake.mainChatId(), { id: `sug-${++startN}`, text }),
      paused: () => momoFake.prefs.get().paused,
    });
    void momoFake.suggestions.setMode('on');
    // the morning brief (momo-brief): its row and its stack in MoMo's fake chat
    momoFake.brief = createFakeBrief({
      now,
      mainChatId: () => momoFake.mainChatId(),
      app,
      changed: (/** @type {'memory' | 'chat'} */ area) => service.onMomoChanged(area),
      suggestions: async () => (bench.suggestions === 'off' ? { suggestions: [] } : momoFake.suggestions.list()),
    });
    const call = service.call.bind(service);
    service.call = async (/** @type {any} */ client, /** @type {string} */ method, /** @type {unknown} */ params) => {
      const pair = client.pairId;
      const started = Date.now();
      log(requestLine(pair, method, params));
      log(`    ↳ ${explainRequest(method, params)}`);
      try {
        const value = await call(client, method, hostSeesRelay(method, params, realHost?.relayUrl));
        log(replyLine(pair, method, Date.now() - started, { ok: true, value }));
        return value;
      } catch (error) {
        log(
          replyLine(pair, method, Date.now() - started, {
            ok: false,
            error: { code: /** @type {any} */ (error).code ?? 'failed', message: messageOf(error) },
          }),
        );
        throw error;
      }
    };
    /** The sealed channel as the service sees it, with the events it sends logged. */
    const logged = (/** @type {any} */ channel) => ({
      send: (/** @type {string} */ pair, /** @type {any} */ msg) => {
        if (msg.kind === 'event') {
          log(eventLine(pair, msg));
          // a stream of small events is not explained each time
          const why = explainEvent(msg);
          if (why) log(`    ↳ ${why}`);
        }
        return channel.send(pair, msg);
      },
      onMessage: (/** @type {Function} */ fn) => channel.onMessage(fn),
      pairs: () => channel.pairs(),
      onPairsChanged: (/** @type {Function} */ fn) => channel.onPairsChanged(fn),
      presence: (/** @type {string} */ pair) => channel.presence(pair),
    });

    const mac = openRemote({
      userData: path.join(dir, 'mac'),
      live: {
        mopilot: { relayToken: () => account.sign(MAC_ID, false, 'relay'), ...(qrAccount && { creds: { user: qrAccount } }) },
        notifier: /** @type {any} */ ({ onBanner: null, onCatchUp: null }),
        // the Mac's opt-in for MoMo's push body, switched by the push-body scenario
        momoPushBodyOn: () => bench.pushBody === true,
      },
      safeStorage: scratchSafeStorage(dir),
      fs: fsp,
      relayUrl,
      // the Mac reaches its own relay on loopback; the QR carries the address the phone uses
      createSocket: (_url, headers) => /** @type {any} */ (new WebSocket(`ws://127.0.0.1:${listening}/v1/ws`, { headers })),
      scope: () => JSON.stringify([USER.id, MAC_ID]),
      optedIn: () => true,
      flagOn: () => true,
      confirm:
        confirm ??
        (async ({ device, safetyNumber }) => {
          log(`pairing: ${device.name} asks to pair; safety number ${safetyNumber} (allowed)`);
          return 'allow';
        }),
      onChannel: (/** @type {any} */ channel) => {
        if (channel) {
          channel.o.relay.on('state', (/** @type {string} */ s) => log(`relay: Mac connection ${s}`));
          channel.o.relay.on('error', (/** @type {any} */ e) => log(`relay: refused ${JSON.stringify(e)}`));
          // a session that pauses (a burst, a failed save) or ends, and comes back: counted, so a stuck pair is visible in the console
          channel.onPairClosed((/** @type {any} */ e) =>
            log(`channel: session ${e.code} for ${e.pairId} ${JSON.stringify(channel.stats)}`),
          );
          channel.onPairReopened((/** @type {any} */ e) =>
            log(`channel: session back after ${e.code} for ${e.pairId} ${JSON.stringify(channel.stats)}`),
          );
          gateRemote({ service, transport: logged(channel), enabled: () => true });
        } else service.detach();
      },
    });
    remote = mac;
    await mac.sync();
    if (!mac.running) throw new Error('Mobile Remote did not start');
    /** @type {NonNullable<typeof mac.pairing>} */ (mac.pairing).onEvent((e) =>
      log(`pairing: ${e.state}${e.deviceName ? ` (${e.deviceName})` : ''}`),
    );
    const end = Date.now() + readyMs;
    while (mac.channel?.o.relay.state !== 'open') {
      if (Date.now() > end) throw new Error('The Mac did not reach its own relay');
      await new Promise((r) => setTimeout(r, 20));
    }

    const controls = createControls({
      bench,
      relayClient: () => /** @type {any} */ (mac.channel).o.relay,
      async restartRelay(downMs) {
        if (restartBusy) throw new Error('A relay restart is already under way.');
        restartBusy = true;
        restarting = (async () => {
          await relay?.close();
          await new Promise((r) => setTimeout(r, downMs));
          // stopped while it was down: stay down; the port taken by someone else: say so instead of crashing
          if (stopped) return;
          await assertPortFree(listening, bind);
          relay = makeRelay();
          await relay.listen(listening, bind);
        })();
        try {
          await restarting;
        } finally {
          restarting = null;
          restartBusy = false;
        }
      },
      advanceCounters: (n, pairId) => advanceTx({ channel: mac.channel, devices: mac.devices, n, pairId }),
      cutMac(ms) {
        macBlockedUntil = Date.now() + ms;
        // the socket the Mac has open goes now; its client queues what it sends and reconnects with backoff
        relay?.hub.conns.get(MAC_ID)?.socket.terminate();
      },
      momoRemind: (/** @type {string | undefined} */ title) => momoFake.remind(title),
      momoTaskCard: () => momoFake.tasks.raiseCard(),
      momoSuggestions: (/** @type {'on' | 'empty'} */ mode) => momoFake.suggestions.setMode(mode),
      momoBrief: (/** @type {'on' | 'off' | 'failed'} */ mode) => momoFake.brief.setMode(mode),
      momoDraft: (/** @type {string} */ shape) => momoFake.draft(shape),
      momoOptions: (/** @type {string} */ shape) => momoFake.options(shape),
      momoReport: (/** @type {string} */ shape) => momoFake.report(shape),
      momoRecipientsCard: (/** @type {string} */ shape) => momoFake.recipientsCard(shape),
      momoSwitched(on) {
        // a phone that follows MoMo's chat loses it when MoMo goes away
        if (!on) for (const phone of service.phones.values()) phone.client.follows.delete(MAIN_CHAT);
      },
      devices: () => /** @type {NonNullable<typeof mac.devices>} */ (mac.devices).list(),
      unpair: (deviceId, pairId) => /** @type {NonNullable<typeof mac.pairing>} */ (mac.pairing).unpair(deviceId, pairId),
      pushRequest: (req) => /** @type {NonNullable<typeof mac>} */ (mac).pushRequest(req),
      // whether the relay holds a Host connection right now
      linkState: () => ({
        hostLinked: [.../** @type {NonNullable<typeof relay>} */ (relay).hub.conns.values()].some((c) => c.identity.kind === 'host'),
      }),
      seal: (pair, ref, title) => mac.pushTitles?.seal(pair, ref, title) ?? null,
      sealBody: (pair, ref, text) => /** @type {NonNullable<typeof mac.pushTitles>} */ (mac.pushTitles).sealBody(pair, ref, text),
      setTitles: async (on) => void (await /** @type {NonNullable<typeof mac.pushTitles>} */ (mac.pushTitles).setEnabled(on)),
      chatTitle: (id) => app.chats.get(id)?.title ?? null,
      hosts: hosts && {
        toggle: () => hosts.toggle(),
        setAgent: (machine, agent, state) => hosts.setAgent(machine, agent, state),
        changed: () => service.onMachinesChanged(),
        direct: (pairId, on) => hosts.setDirect(pairId, on),
        card: (text) => hosts.hostCard(text),
        waitCard: (chatId, limitMs) => hosts.hostWaitCard(chatId, limitMs),
        answer: (kind) => hosts.hostAnswer(kind),
        status: () => hosts.hostStatus(),
        chat: (harness, text) => hosts.hostChat(harness, text),
      },
      changed: (area) => service.onMomoChanged(area),
      // a timer that outlives the host does nothing
      after: (ms, fn) => setTimeout(() => stopped || fn(), ms).unref(),
      log,
    });
    return {
      port: listening,
      relayUrl,
      /** Where the phone signs in (the app build's account origin). */
      accountUrl: `http://${origin}`,
      repo,
      account,
      app,
      service,
      remote: mac,
      shellsReal: terminals.real,
      scenarios: withMomoChannels(
        withMomoEcho(
          withMomoShell(createScenarios({ app, now, controls }), bench, (area) => service.onMomoChanged(area)),
          bench,
        ),
        bench,
        fakeChannels,
        (area) => service.onMomoChanged(area),
      ),
      stop,
      /** A pairing QR payload (a JSON string, also what a pasted code is) and when it stops working. */
      async pair() {
        const { qr, expiresAt } = await /** @type {NonNullable<typeof mac.pairing>} */ (mac.pairing).begin();
        return { qr, expiresAt };
      },
      /** The paired phones. */
      devices: () => /** @type {NonNullable<typeof mac.devices>} */ (mac.devices).list().map((d) => ({ id: d.id, name: d.name })),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
