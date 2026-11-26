// The Host's composition root for chats: the same SessionStore, ChatsStore and ChatController the app runs (electron/session, electron/platform/chats.cjs), with the ACP adapter on this Host's AcpHost. A chat's id names its family (`acp:<harness>:<id>`, `claude:<id>`, a bare Codex id), the controller routes by it, queues a message sent while a turn runs, and keeps the turn state machine; a family this Host does not run refuses explicitly (./families.mjs).
//
// How a family plugs in: pass `families.claude` and/or `families.codex`, each a function of the context below that returns the adapter objects the controller takes
// (`{ claudeTurns, claude }` and `{ codex }`; see the ChatController constructor). Such an adapter reports what happens in a turn by calling `ctx.emit(event)` with the
// minimal turn events the protocol turns into stream frames: `{ kind: 'turnStart', key, turnId }`, `{ kind: 'update', turnId, update: { sessionUpdate: 'agent_message_chunk', content: { text } } }`
// and `{ kind: 'turnEnd', turnId, stopReason, error? }`, and feeds the controller its own events (`ctx.controller().onClaudeEvent` / the Codex equivalents) as the app's wiring does.
import { typedTurnEnd } from '../../shared/host/turnErrorCode.mjs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { UnsupportedError } from './errors.mjs';
import { unavailableFamily } from './families.mjs';
import { createQueueStore } from './queueStore.mjs';
import { HostRefusal } from './hostFs.mjs';
import { userInput } from '../../shared/userInput.mjs';
import { convertImage } from './imageDecoder.mjs';
import { createMomoIsolation } from './momoIsolation.mjs';
import { createHostSwitcher, folderReader, landsOn, readHold, settlingPick, switchRuntime } from './hostSwitch.mjs';
import { sessionLaneEvent } from './chatState.mjs';
import { createContinueRuntime } from './continueRuntime.mjs';
import { goalRuntime } from './goalRuntime.mjs';
import { createChatRename, dropsTitle } from './chatRename.mjs';
import { createChatRetire } from './chatRetire.mjs';
import { createChatPreparation } from './chatPreparation.mjs';
import { sideChatParentOf } from './nativeSideChat.mjs';

const require = createRequire(import.meta.url);
const { ChatsStore } = require('../../electron/platform/chats.cjs');
const { identifyInput, guardSend } = require('../../electron/session/contract/inputGuard.cjs');
const { ChatController } = require('../../electron/session/controller.cjs');
const { SessionStore } = require('../../electron/session/state.cjs');
const { AcpTurns } = require('../../electron/harness/acpTurns.cjs');
const { localHostFor } = require('../../electron/host/wiring.cjs');
const { familyOf } = require('../../electron/session/contract/route.cjs');
const { noteIgnored } = require('../../electron/ignored.cjs');
const { imageDataUrl, readImage } = require('../../electron/harness/claude/message.cjs');

/** How the person knows a family the Host may not run. */
const FAMILY_LABEL = { claude: 'Claude Code', codex: 'Codex' };

/**
 * What a family factory is given, and may keep.
 * @typedef {object} FamilyContext
 * @property {{ dataDir: string }} paths
 * @property {NodeJS.ProcessEnv} env
 * @property {InstanceType<typeof SessionStore>} state
 * @property {InstanceType<typeof ChatsStore>} chats
 * @property {() => InstanceType<typeof ChatController>} controller late-bound: the controller is built after the families
 * @property {((chatId: string, clientId: string) => any)} [userOf] pending display input, keyed by stable client identity
 * @property {(event: object) => void} emit report a turn event to the Host's stream
 * @property {() => string | undefined} [ceiling] the most trusting permission mode the owner's rules allow now (their `permissionMax`): a chat's tools never run above it, whenever its mode was set
 * @property {(line: string) => void} log a content-free line for the Host's own log (host.log): what a family did, never what was said
 */

/**
 * @param {object} o
 * @param {{ dataDir: string }} o.paths
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {ReturnType<typeof import('./acp.mjs').createAcpRuntime>} o.runtime the ACP runtime (its AcpHost runs ACP chats)
 * @param {{ claude?: (ctx: FamilyContext) => { claudeTurns: any, claude: any, loginRefused?: () => boolean, settling?: () => boolean, prepare?: (key: string, cwd?: string, check?: () => void) => Promise<void>, noteUser?: (turnId: string, text: string, user?: any) => void, models?: () => object[], logins?: () => object[], setPermission?: (chatId: string, value: string) => Promise<void>, goal?: (p: any) => Promise<unknown>, permit?: (p: { requestId: string, optionId?: string, form?: { action: string, content?: object } }) => boolean, close?: () => unknown }, codex?: (ctx: FamilyContext) => { codex: any, check?: (chatId?: string) => Promise<void>, prepare?: (p: Parameters<ReturnType<typeof import('./codexChatStart.mjs').createCodexChatStart>>[0]) => Promise<void | boolean>, setPermission?: (chatId: string, value: string) => Promise<void>, goal?: (p: any) => Promise<unknown>, permit?: (p: { requestId: string, optionId?: string, form?: { action: string, content?: object } }) => boolean, close?: () => void } }} [o.families]
 * @param {{ chatCredentials: { moved: (chatId: string, harness: string) => void } } | null} [o.ownRuns] the chats' credential choices (./ownCredentials.mjs): told when a switch moves a chat to another agent
 * @param {(message: string) => void} [o.report] told when a chat's waiting messages cannot be saved, read or sent after a restart
 * @param {(line: string) => void} [o.log] the Host's log, for content-free lines (the Codex stop path writes its steps here)
 * @param {() => string | undefined} [o.ceiling] the owner's permission ceiling now (./policy.mjs `permissionMax`), read by a family each time a turn takes its mode
 */
export function createHostSessions({
  paths,
  env = process.env,
  runtime,
  families = {},
  ownRuns = null,
  report = (message) => noteIgnored("keep a chat's waiting messages", new Error(message)),
  log = () => undefined,
  ceiling = () => undefined,
}) {
  /** Whether a spend limit holds the chat: its next waiting message stays queued until the limit allows (./spend.mjs); given by `holdBy` once the counter exists. @type {(chatId: string) => boolean} */
  let spendHeld = () => false;
  const acpHost = runtime.host;
  const chats = new ChatsStore(path.join(paths.dataDir, 'threads'));
  /** @type {InstanceType<typeof ChatController>} */
  let controller;
  const sessions = new SessionStore();
  /** What the protocol listens to: the ACP host's events, and what a family adapter emits. */
  const bus = new EventEmitter();
  const inputs = new Map();
  const inputKey = (chatId, clientId) => JSON.stringify([chatId, clientId]);
  // what waits behind a running turn is kept on disk, so the next Host on this data folder still has it (./queueStore.mjs)
  const queues = createQueueStore({ dir: path.join(paths.dataDir, 'queues'), report });
  /** Per chat, the message taken off the queue whose turn has not started yet. @type {Map<string, any>} */
  const starting = new Map();
  /** Per chat, the choice of another agent the person made and no message has settled: kept with the chat's waiting messages, credential and all, in the same private file. @type {Map<string, object>} */
  const holds = new Map();
  const plain = (/** @type {any} */ item) => ({ id: item.id, text: item.text, attachments: item.attachments ?? [], opts: item.opts ?? {} });
  /** Writes the chat's waiting messages as they are now: the one being started first, then the queue. @param {string} chatId */
  const persist = (chatId) => {
    const taken = starting.get(chatId);
    const items = [...(taken ? [taken] : []), ...sessions.get(chatId).queue].filter(
      (item, i, all) => all.findIndex((x) => x.id === item.id) === i,
    );
    const held = holds.get(chatId);
    try {
      queues.put(
        chatId,
        items.length || held
          ? {
              chatId,
              items: items.map(plain),
              users: Object.fromEntries(
                items.flatMap((item) => (inputs.has(inputKey(chatId, item.id)) ? [[item.id, inputs.get(inputKey(chatId, item.id))]] : [])),
              ),
              ...(held ? { pendingSwitch: held } : {}),
            }
          : null,
      );
    } catch (error) {
      report(`A chat's waiting messages could not be saved: ${/** @type {Error} */ (error).message}`);
    }
  };
  /** The message taken to start has started, or will not: it no longer waits. @param {string} chatId */
  const settled = (chatId) => {
    if (starting.delete(chatId)) persist(chatId);
  };
  // Explicit queue removal retires display inputs; takeNext transfers them to the adapter and bypasses patch.
  let transferring = 0;
  const patch = sessions.patch;
  sessions.patch = function (chatId, partial) {
    const before = this.get(chatId).queue;
    const changed = patch.call(this, chatId, partial);
    if (changed && !transferring && Object.hasOwn(partial, 'queue')) {
      const kept = new Set(this.get(chatId).queue.map((item) => item.id));
      for (const item of before) if (!kept.has(item.id)) inputs.delete(inputKey(chatId, item.id));
    }
    if (changed && Object.hasOwn(partial, 'queue')) persist(chatId);
    return changed;
  };
  // the store takes the next message off the queue itself: it stays on disk until its turn starts
  const takeNext = sessions.takeNext;
  sessions.takeNext = function (chatId, held) {
    const next = takeNext.call(this, chatId, () => spendHeld(chatId) || !!held?.());
    if (next) {
      starting.set(chatId, next);
      persist(chatId);
    }
    return next;
  };
  const emit = (/** @type {any} */ event) => {
    // a native session a switch started names its chat: the stream is the chat's, whichever agent's session said it
    for (const field of ['key', 'chatId']) {
      const chat = typeof event[field] === 'string' ? controller?.chatOf(event[field]) : undefined;
      if (chat && chat !== event[field]) event = { ...event, [field]: chat };
    }
    if (dropsTitle(chats, event)) return;
    // a turn that started is the journal's from here on, not the queue's
    if (event.kind === 'turnStart' && typeof event.key === 'string') settled(event.key);
    if (event.kind === 'turnStart' && event.user?.clientId) {
      const key = inputKey(event.key, event.user.clientId);
      const user = inputs.get(key);
      if (user) {
        event = { ...event, user };
        inputs.delete(key);
      }
    }
    // a failed turn's end says why in a code a client can act on (shared/host/turnErrorCode.mjs)
    bus.emit('event', event.kind === 'turnEnd' ? typedTurnEnd(event) : event);
  };
  acpHost.on('event', (/** @type {any} */ e) => {
    controller?.onAcpEvent(e);
    if (e.kind !== 'promptSuggestion') emit(e);
  });
  // a chat's goal and background tasks reach the stream as they change in the store (./chatState.mjs)
  const published = sessions.publish;
  sessions.publish = (change) => {
    published.call(sessions, change);
    // a turn that ended or failed without starting the message taken for it leaves that message to the controller (it puts it back, or reports it)
    if (Object.hasOwn(change.patch, 'turn') && !['running', 'awaitingUser'].includes(change.patch.turn)) settled(change.chatId);
    const lane = sessionLaneEvent(change);
    if (lane) emit(lane);
  };
  /** @type {FamilyContext} */
  const ctx = {
    paths,
    env,
    state: sessions,
    chats,
    controller: () => controller,
    emit,
    log,
    ceiling,
    userOf: (chatId, clientId) => inputs.get(inputKey(chatId, clientId)),
  };
  const claudeFamily = families.claude?.(ctx);
  const claude = claudeFamily ?? { claudeTurns: unavailableFamily('Claude Code'), claude: unavailableFamily('Claude Code') };
  const codexFamily = families.codex?.(ctx);
  const codex = codexFamily ?? { codex: unavailableFamily('Codex') };

  const acpTurns = new AcpTurns({
    send: (/** @type {string} */ chatId, /** @type {string} */ key, /** @type {object} */ payload, /** @type {object} */ meta) =>
      controller.acpSend(chatId, key, payload, meta),
    rename: () => undefined,
    // the types the model APIs take; a BMP is decoded here, and an image nothing can read is said not to be attached
    readImage: (/** @type {string} */ file) => imageDataUrl(file, convertImage),
    home: paths.dataDir,
    emit: (/** @type {object} */ event) => (emit(event), false),
    turnCheck: (/** @type {string} */ chatId) => controller.turnCheck(chatId),
  });
  // a chat's move to another agent settles with its next message, on this Host's own families (./hostSwitch.mjs)
  /** Who hears of a settled switch: the protocol journals it (./chatEffects.mjs). @type {Set<(chatId: string, note: object) => void>} */
  const switchedListeners = new Set();
  const switcher = createHostSwitcher({
    chats,
    controller: () => controller,
    claude,
    codex: codex.codex,
    acpHost,
    home: os.homedir(),
    claudeBin: /** @type {{ bin?: () => string | undefined } | undefined} */ (claudeFamily)?.bin,
    emit,
    // the switch settled: the choice is spent, and the chat's credential choice moves with its agent
    settled: (/** @type {string} */ chatId, /** @type {string} */ harness) => {
      holds.delete(chatId);
      persist(chatId);
      try {
        ownRuns?.chatCredentials.moved(chatId, harness);
      } catch (error) {
        report(`A chat's credential choice could not be moved to its new agent: ${/** @type {Error} */ (error).message}`);
      }
    },
    told: (/** @type {string} */ chatId, /** @type {object} */ note) => switchedListeners.forEach((fn) => fn(chatId, note)),
    log,
  });
  controller = new ChatController({
    state: sessions,
    chats,
    codex: codex.codex,
    claudeTurns: claude.claudeTurns,
    claude: claude.claude,
    // how a Claude message's images are read (the same types)
    readImage: (/** @type {string} */ file) => readImage(file, convertImage),
    acpTurns,
    switcher,
    acp: acpHost,
  });
  const removeQueued = controller.removeQueued;
  controller.removeQueued = function (chatId, id, release = true) {
    if (!release) transferring++;
    try {
      return removeQueued.call(this, chatId, id, release);
    } finally {
      if (!release) transferring--;
    }
  };
  // what the last Host on this data folder had accepted and not started waits in its chat's queue again, in the order it was sent.
  // It is held the way a queue is after a Stop or a crash: nothing is sent by the restart itself, and it goes after the chat's next turn.
  /** @type {import('./queueStore.mjs').QueueRecord[]} */
  let left = [];
  try {
    left = queues.all();
  } catch (error) {
    report(`The waiting messages of this Host's chats could not be read: ${/** @type {Error} */ (error).message}`);
  }
  for (const record of left) {
    const items = record.items.map((kept) => {
      const item = plain(kept);
      identifyInput(item, item.id);
      return item;
    });
    for (const [id, user] of Object.entries(record.users ?? {})) inputs.set(inputKey(record.chatId, id), user);
    if (items.length) patch.call(sessions, record.chatId, { queue: items });
    // the choice of another agent the last Host had not settled is the chat's again before any message is taken
    const held = record.pendingSwitch === undefined ? null : readHold(record.pendingSwitch);
    if (record.pendingSwitch !== undefined && !held)
      report(`A chat's choice of another agent could not be read and was dropped: ${record.chatId}`);
    if (held) {
      holds.set(record.chatId, held);
      patch.call(sessions, record.chatId, { pendingSwitch: held });
    }
    if (record.pendingSwitch !== undefined && !held) persist(record.chatId);
  }
  /** The families this Host runs: ACP always, Claude Code and Codex when a factory supplied their adapters. */
  const provided = { acp: true, claude: Boolean(families.claude), codex: Boolean(families.codex) };
  const host = localHostFor({
    live: {
      chats,
      // the permission mode new turns run under is a window setting on the app; the Host has no window to hold it
      patchPrefs: () => {
        throw new UnsupportedError('This host cannot change the permission mode.');
      },
    },
    controller,
    sessions,
    claudeTurns: claude.claudeTurns,
  });
  const isolation = createMomoIsolation({ claudeFamily, codexFamily, codex, claude, switcher, acpHost, controller });
  const api = {
    chats,
    state: sessions,
    controller,
    /** Lets a spend counter hold chats' waiting messages. @param {(chatId: string) => boolean} fn */
    holdBy(fn) {
      spendHeld = fn;
    },
    /** Tries the chat's next waiting message now, as when a limit that held it is raised. @param {string} chatId */
    drainChat: (chatId) =>
      controller.drain(chatId)?.catch((/** @type {Error} */ error) => report(`A waiting message could not be sent: ${error.message}`)),
    /** The Host interface (electron/host/interface.cjs) over these services. */
    host,
    ...isolation, // MoMo's chats kept apart from the coding side (./momoIsolation.mjs)
    /** Whether no chat has a turn running or waiting on a person (a chat whose harness quit counts as idle): a Host that restarts for an update waits for this. */
    idle: () => sessions.all().every((/** @type {string} */ chatId) => !['running', 'awaitingUser'].includes(sessions.get(chatId).turn)),
    /** What the idle stop reads of the chats: a turn running, a turn waiting on a card, a message queued behind a turn or a limit. */
    busy() {
      const all = sessions.all().map((/** @type {string} */ chatId) => sessions.get(chatId));
      return {
        turnRunning: all.some((/** @type {any} */ s) => s.turn === 'running'),
        cardWaiting: all.some((/** @type {any} */ s) => s.turn === 'awaitingUser'),
        queued: all.some((/** @type {any} */ s) => s.queue.length > 0),
      };
    },
    /** The logins this Host's Claude Code has; none for any other agent. */
    loginsOf: (/** @type {string} */ family) => (family === 'claude' ? (claudeFamily?.logins?.() ?? []) : []),
    /** Whether the agent's login was found unusable by a turn here (see claudeFamily.loginRefused). */
    loginRefusedOf: (/** @type {string} */ family) => family === 'claude' && claudeFamily?.loginRefused?.() === true,
    settlingOf: (/** @type {string} */ family) => family === 'claude' && claudeFamily?.settling?.() === true,
    modelsOf: (/** @type {string} */ family) => (family === 'claude' ? (claudeFamily?.models?.() ?? []) : runtime.models(family)),
    /** Turn events as the protocol reads them. */
    events: bus,
    /**
     * What the protocol drives: a message goes through the controller (queued while a turn runs), Stop through the Host interface, events from the bus.
     * `cwd` is where a chat's session starts; it is read once, when the chat has none yet.
     */
    chatRuntime: {
      /** @param {(chatId: string, note: object) => void} fn */
      onSwitched: (fn) => void switchedListeners.add(fn),
      ...switchRuntime({
        chats,
        state: sessions,
        controller: () => controller,
        provided,
        labels: FAMILY_LABEL,
        hold: (chatId, pending) => (pending ? holds.set(chatId, pending) : holds.delete(chatId), persist(chatId)),
        folderOf: folderReader({ switcher, controller: () => controller }),
      }),
      ...goalRuntime({ chats, state: sessions, controller, familyOf, claude: claudeFamily, codex: codexFamily }),
      // what a continue asks of the chats here, for every family (./continueRuntime.mjs)
      ...createContinueRuntime({
        chats,
        state: sessions,
        controller: () => controller,
        acpHost,
        switcher,
        provided,
        labels: FAMILY_LABEL,
        starting: (chatId) => starting.has(chatId),
        discard: (chatId) => api.chatRuntime.discardQueued(chatId),
        cancel: (chatId) => api.chatRuntime.host.cancel(chatId),
        announce: (chatId, harness) => emit({ kind: 'state', chatId, patch: { harness, pendingSwitch: null } }),
        ready: async (chatId, family) => {
          if (family === 'codex') await codexFamily?.check?.(chatId);
        },
      }),
      // the person's name for a chat (./chatRename.mjs); a deleted chat's record, transcript and agent session (./chatRetire.mjs)
      rename: createChatRename({ chats, controller: () => controller, claude: claudeFamily, codex: codexFamily, emit, report }),
      retire: createChatRetire({ chats, acpHost, claude: claudeFamily, codex: codexFamily, env, report, log }),
      discardQueued(chatId) {
        // the message being started goes too, and a choice nobody settled: a chat that is retired keeps nothing on disk
        starting.delete(chatId);
        const held = holds.delete(chatId);
        if (sessions.has(chatId)) sessions.patch(chatId, { queue: [] });
        if (!sessions.has(chatId) || held) persist(chatId);
      },
      host: Object.assign(bus, {
        cancel: async (/** @type {string} */ key) => {
          // An old Stop finalizer may only release the inputs it observed, never replacements sent while it awaited the harness.
          const pending = [...inputs].filter(([id]) => JSON.parse(id)[0] === key);
          try {
            return await host.stop(key);
          } finally {
            for (const [id, user] of pending) if (inputs.get(id) === user) inputs.delete(id);
          }
        },
      }),
      /** The family the chat's events belong to: `acp`, `codex` or `claude`, by the chat's current segment. @param {string} chatId */
      familyOf: (chatId) => familyOf(controller.ref(chatId).kind),
      /** Answer a permission card an ACP turn waits on: its id and the option picked (none: dismissed). False when the card is gone. @param {{ requestId: string, optionId?: string, form?: { action: string, content?: object } }} p */
      permit: ({ requestId, optionId, form }) =>
        acpHost.permission(requestId, optionId) ||
        (codexFamily?.permit?.({ requestId, optionId, form }) ?? false) ||
        (claudeFamily?.permit?.({ requestId, optionId, form }) ?? false),
      prepare: createChatPreparation({ chats, controller, claudeFamily, codexFamily }),
      sideChatParent: sideChatParentOf(chats, controller),
      /**
       * The permission mode the chat's later turns run under, where the family can set one (Claude Code, Codex); otherwise the request is refused, not pretended.
       * @param {{ chatId: string, value: string }} p
       */
      async setMode({ chatId, value }) {
        const family = familyOf(controller.ref(chatId).kind);
        if (family === 'acp') {
          // an ACP agent's modes are its own: one it refuses (or that cannot be reached), is a coded refusal the composer can show
          try {
            await acpHost.setMode(chatId, value);
          } catch (error) {
            throw new HostRefusal('mode_unavailable', error instanceof Error ? error.message : 'This agent could not change its mode.');
          }
          return;
        }
        const owner = family === 'claude' ? claudeFamily : family === 'codex' ? codexFamily : undefined;
        if (!owner?.setPermission) throw new UnsupportedError('This host cannot change the permission mode.');
        await owner.setPermission(chatId, value);
        // the chat's lane says the mode it is in now, to every client that reads it (and to the next one that subscribes)
        emit({ kind: 'state', chatId, patch: { permission: value, plan: value === 'plan' } });
      },
      /** @param {{ key: string, text: string, cwd?: string, pick?: { model?: string, effort?: string }, human?: boolean, prefix?: string, followUp?: 'steer', goal?: boolean, attachments?: any[], clientId?: string, check?: () => void }} p */
      async send({ key, text, cwd, pick, human, prefix, followUp, goal, attachments = [], clientId, check = () => undefined }) {
        check();
        // refused before anything is queued: a chat of a family this Host does not run would otherwise keep a message it can never deliver
        const family = familyOf(controller.ref(key).kind);
        if (!provided[family]) throw new UnsupportedError(`${FAMILY_LABEL[family]} is not available on this Host.`);
        // a family that is not installed or signed out here says so before the message is kept
        if (family === 'codex') await codexFamily?.check?.(key);
        check();
        if (cwd && !acpTurns.sessions.has(key)) acpTurns.registerSession(key, { cwd });
        // a Claude Code chat the Host has no session for starts in `cwd`, or resumes the transcript on disk (the chat's own Claude session: a chat that switched to Claude Code is not named by its id)
        if (family === 'claude') await claudeFamily?.prepare?.(controller.ref(key).key, cwd, check);
        check();
        // the message's own id names its turn on the stream, so what the person wrote can be told with the turn's start (a refused or retained message carries its own `error`)
        const id = clientId ?? crypto.randomUUID();
        if (inputs.size >= 1000)
          throw new HostRefusal('unsupported', 'Too many messages are waiting on this Host. Try again when a turn ends.');
        const user = { id: `u-${id}`, clientId: id, messageKey: id, content: userInput(text, attachments) };
        if (clientId || attachments.length) inputs.set(inputKey(key, id), user);
        if (landsOn(sessions.get(key).pendingSwitch, family) === 'claude')
          claudeFamily?.noteUser?.(id, text, clientId || attachments.length ? user : undefined);
        const item = {
          id,
          text,
          attachments,
          ...(followUp === 'steer' ? { followUp } : {}),
          // the message that settles a held switch runs on the new agent: the model and effort it was sent with are the old agent's, the held choice's are the new one's
          opts: {
            ...settlingPick(sessions.get(key).pendingSwitch, pick),
            ...(human === true ? { human: true } : {}),
            ...(prefix ? { prefix } : {}),
            ...(goal === true ? { goal: text } : {}),
          },
        };
        identifyInput(item, id);
        /** @type {{ error: unknown } | undefined} */
        let invalidated;
        guardSend(item, () => {
          try {
            check();
          } catch (error) {
            invalidated = { error };
            inputs.delete(inputKey(key, id));
            throw error;
          }
        });
        let receipt;
        try {
          check();
          receipt = await controller.send(key, item, null, true);
        } catch (error) {
          inputs.delete(inputKey(key, id));
          throw error;
        }
        // a message the turn refused to start for is refused, not kept: it would wait in this Host's queue for a turn end while the client shows it as sent
        // (`queued` with no error is the one that waits behind a running turn, and is taken)
        if (receipt.action === 'failed' || (receipt.action === 'queued' && receipt.error)) {
          if (receipt.action === 'queued') controller.removeQueued(key, receipt.id);
          inputs.delete(inputKey(key, id));
          // A native adapter can carry only the error text in its receipt. Keep the caller's ownership refusal intact.
          if (invalidated) throw invalidated.error;
          throw new HostRefusal('unsupported', receipt.error || 'This message could not be sent.');
        }
        return { ...receipt, turnId: receipt.id };
      },
    },
    close() {
      host.dispose();
      codexFamily?.close?.();
      Promise.resolve()
        .then(() => claudeFamily?.close?.())
        .catch((/** @type {unknown} */ error) => noteIgnored('stop the Claude Code harness', error));
    },
  };
  return api;
}
