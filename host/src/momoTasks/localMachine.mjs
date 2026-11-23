// MoMo's tasks on THIS Host: the machine port over the Host's own chats. A task's session is an ordinary chat of the agent the user chose, started in a folder of its own with the brief as its first message; the Host's chat events are read as the typed `SessionEvent`s the task manager takes, one translation for every agent family. Another machine is not reachable from a Host yet, and is not pretended to be.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appIdPrefix, hostChatId, agentOfKind } from '../../../shared/host/chatIds.mjs';
import { MOMO_FORM } from '../momoChats.mjs';
import { holdFor } from './modes.mjs';
import { START_CODE } from '../../../shared/momoTasks/types.ts';

/**
 * What this machine tells MoMo about itself: its display name and how its agents stand. Given by the home's wiring (the Host's `harnesses()` knows readiness), because the services' own dependencies do not carry it.
 * @typedef {{ name?: string, agents: () => Promise<import('../../../shared/momoTasks/types.ts').MachineAgent[]> | import('../../../shared/momoTasks/types.ts').MachineAgent[], outdated?: () => boolean, installable?: () => boolean }} MachineInfoSource
 */

/** The turn states of a chat that is still working. */
const WORKING = new Set(['running', 'awaitingUser']);

/**
 * A Host chat's end, as the task manager reads it. A restart's end says what was cut off; a person's Stop (cancelled, no error) is the manager's own Stop and says nothing; an error carries the typed code the Host gave it (`rate_limit`, `auth`, ...); anything else is the reply.
 * @param {any} end the `turnEnd` event @param {string} text the turn's reply
 * @returns {import('../../../shared/momoTasks/types.ts').SessionEvent | null}
 */
export function endOf(end, text) {
  if (end.interrupted) return { kind: 'lost', reason: end.interrupted.by === 'host_restart' ? 'machine_restarted' : 'session_gone' };
  if (end.error) return { kind: 'failed', signal: end.error.code, message: String(end.error.message ?? end.error) };
  if (end.stopReason === 'cancelled') return null;
  return { kind: 'finished', report: text };
}

/**
 * @param {object} o
 * @param {{ events: import('node:events').EventEmitter, state: { get: (id: string) => any, has: (id: string) => boolean }, chatRuntime: { send: (p: any) => Promise<unknown>, setMode: (p: any) => Promise<void>, host: { cancel: (key: string) => unknown } } }} o.sessions
 * @param {{ stamp: () => { homeId: string } | null }} o.home
 * @param {string} o.workDir where each task's session works, a folder of its own per task (outside the home's storage, so a move or a wipe leaves the files the task made)
 * @param {{ get: (key: string) => string | null, set: (key: string, chatId: string) => Promise<unknown>, delete: (key: string) => Promise<unknown> }} o.keys
 * @param {{ get: (chatId: string) => import('../../../shared/momoTasks/types.ts').SessionEvent | null, set: (chatId: string, event: import('../../../shared/momoTasks/types.ts').SessionEvent) => Promise<unknown> }} o.ends how each session last ended
 * @param {(machineId: string, chatId: string, event: import('../../../shared/momoTasks/types.ts').SessionEvent) => unknown} o.emit
 * @param {(message: string) => void} o.report
 * @param {() => string | null} o.nameOf this machine's own name, from the home record, when the source gives none
 * @param {() => string} [o.newId]
 */
export function createLocalMachine({ sessions, home, workDir, keys, ends, emit, report, nameOf, newId = () => crypto.randomUUID() }) {
  /** @type {MachineInfoSource | null} */
  let info = null;
  /** The chats of tasks that are working, with the reply of the turn running now. @type {Map<string, string>} */
  const texts = new Map();
  /** The tracked chats that wait on the person's approval now. @type {Set<string>} */
  const waiting = new Set();
  let attached = false;
  /** @param {unknown} error */
  const said = (error) => (error instanceof Error ? error.message : String(error));
  // the id of this Host as the home last had it: a session this Host started is still its own to stop after the lease is gone (a stray, a pause)
  let own = /** @type {string | null} */ (null);
  const machineId = () => {
    const id = home.stamp()?.homeId ?? null;
    if (id) own = id;
    return id;
  };
  /** This machine's name: the wiring's, else the home record's, else plain words. */
  const label = () => info?.name ?? nameOf() ?? 'this machine';
  /** @param {string} chatId */
  const track = (chatId) => void (texts.has(chatId) || texts.set(chatId, ''));

  /** @param {any} e */
  const onEvent = (e) => {
    const chatId = typeof e?.key === 'string' ? e.key : e?.chatId;
    if (typeof chatId !== 'string' || !texts.has(chatId)) return;
    const id = /** @type {string} */ (machineId());
    if (e.kind === 'turnStart') texts.set(chatId, '');
    else if (e.kind === 'update' && e.update?.sessionUpdate === 'agent_message_chunk')
      texts.set(chatId, /** @type {string} */ (texts.get(chatId)) + String(e.update.content?.text ?? ''));
    else if (e.kind === 'turnEnd') {
      const event = endOf(e, /** @type {string} */ (texts.get(chatId)));
      texts.set(chatId, '');
      waiting.delete(chatId);
      // kept first, so a home that is not listening now still finds how the session ended
      if (event)
        Promise.resolve(ends.set(chatId, event))
          .then(() => emit(id, chatId, event))
          .catch((error) => report(`MoMo task event for ${chatId}: ${said(error)}`));
    }
  };

  return {
    /** The machine's name and agents, from the home's wiring. @param {MachineInfoSource} source */
    bind(source) {
      info = source;
    },
    /** Reads the Host's chat events until `detach`. */
    attach() {
      if (attached) return;
      attached = true;
      sessions.events.on('event', onEvent);
    },
    detach() {
      attached = false;
      sessions.events.off('event', onEvent);
      texts.clear();
      waiting.clear();
    },
    /** A chat of a task that is working now (found again after a restart, or just started). @param {string} chatId */
    track,
    /** How many chats are followed. */
    size: () => texts.size,
    /** @param {string} chatId */
    untrack(chatId) {
      texts.delete(chatId);
      waiting.delete(chatId);
    },
    /**
     * Where a tracked chat waits on the person: the Host's approval card is the one to answer, so the task is `needs_you` with that card's marker until the turn goes on.
     * @returns {Promise<void>}
     */
    async poll() {
      const id = machineId();
      if (!id) return;
      for (const chatId of [...texts.keys()]) {
        const turn = sessions.state.has(chatId) ? sessions.state.get(chatId).turn : null;
        if (turn === 'awaitingUser' && !waiting.has(chatId)) {
          waiting.add(chatId);
          await emit(id, chatId, {
            kind: 'needs_you',
            line: `Waiting for your approval on ${label()}`,
            cardId: `approval:${chatId}`,
          });
        } else if (turn !== 'awaitingUser' && waiting.delete(chatId)) await emit(id, chatId, { kind: 'resumed' });
      }
    },
    /** The port the task manager takes. @returns {import('../../../shared/momoTasks/types.ts').MachinePort} */
    port() {
      return {
        list: async () => {
          const id = machineId();
          if (!id || !info) return [];
          return [
            {
              machineId: id,
              name: label(),
              online: true,
              outdated: info.outdated?.() === true,
              installable: info.installable?.() === true,
              agents: await info.agents(),
            },
          ];
        },
        start: async (req) => {
          const id = machineId();
          if (!id || req.machineId !== id)
            return { ok: false, code: START_CODE.machineOffline, message: "MoMo's home can't reach that machine from here." };
          const done = keys.get(req.key);
          // the first start of this attempt already made its chat, and the Host has it: it is that one, never a second
          if (done && sessions.state.has(done)) {
            track(done);
            return { ok: true, sessionId: done };
          }
          const agent = /** @type {string} */ (agentOfKind(req.harness));
          const hold = holdFor(agent, { readOnly: req.readOnly });
          if ('unsupported' in hold) return { ok: false, code: START_CODE.readOnlyUnsupported, message: hold.unsupported };
          const chatId = hostChatId(`${appIdPrefix(agent)}${newId()}`);
          // a task's chat is an ordinary chat of its agent: never a MoMo chat, so it is never given MoMo's own tools (so nothing in it can schedule, make a task or a rule)
          if (MOMO_FORM.test(chatId)) throw new Error('A task chat must not have the form of a MoMo chat.');
          const cwd = path.join(workDir, req.itemId);
          fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
          // claimed before anything runs, so a crash after the send is found by the same key; given back if nothing started
          await keys.set(req.key, chatId);
          try {
            // the mode is set before the first message and always, so a task never inherits a looser mode of the machine
            await sessions.chatRuntime.setMode({ chatId, value: hold.mode });
            texts.set(chatId, '');
            await sessions.chatRuntime.send({ key: chatId, text: req.brief, cwd });
          } catch (error) {
            texts.delete(chatId);
            await keys.delete(req.key);
            return { ok: false, code: /** @type {any} */ (error)?.code ?? 'refused', message: said(error) };
          }
          return { ok: true, sessionId: chatId };
        },
        stop: async (machine, chatId) => {
          // a session that runs on another Host (the task kept its machine through a move) is not this Host's to cancel: the task says it may still be running
          if (machine !== (machineId() ?? own)) throw new Error('That session runs on another machine.');
          await sessions.chatRuntime.host.cancel(chatId);
        },
        probe: async (_machine, chatId) => {
          const turn = sessions.state.has(chatId) ? sessions.state.get(chatId).turn : null;
          if (WORKING.has(turn)) return { state: 'running' };
          // it ended while MoMo was not looking: how it ended was kept; a chat with no kept end is gone
          const end = ends.get(chatId);
          return end ? { state: 'ended', event: end } : { state: 'gone' };
        },
      };
    },
  };
}
