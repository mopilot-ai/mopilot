// MoMo's tasks on the user's OTHER machines: the machine port over a home client, beside the local machine and speaking the same words. A task's session is an ordinary chat on that Host, started with the brief, held to "Ask for approval" or read-only, followed through its journal's frames and read by the same translation as a local one.
import crypto from 'node:crypto';
import { appIdPrefix, hostChatId, agentOfKind, isHostFamily } from '../../../shared/host/chatIds.mjs';
import { agentsOf } from '../../../shared/host/agentReadiness.mjs';
import { START_CODE } from '../../../shared/momoTasks/types.ts';
import { holdFor } from './modes.mjs';
import { createTurnReader, waitingIn } from './sessionEvents.mjs';

/** Every chat of a task is at this epoch: the home never moves a chat away from the machine that runs it. */
const EPOCH = 1;
/** What a machine says, as it may be shown in a card: no control characters, bounded. @param {string} text */
const clean = (text) =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .trim()
    .slice(0, 200);
/** @param {string} text */
const keyOf = (text) => `momo-task-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 40)}`;

/**
 * The agents of a Host's status as MoMo's tasks name them (`claude`, `codex`, `acp:<id>`).
 * @param {any[]} harnesses @param {string} machine
 * @returns {import('../../../shared/momoTasks/types.ts').MachineAgent[]}
 */
export const agentsFromStatus = (harnesses, machine) =>
  agentsOf(harnesses, machine).map((a) => ({ id: isHostFamily(a.id) ? a.id : `acp:${a.id}`, state: a.state }));

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./homeClient.mjs').createHomeClient>} o.client
 * @param {ReturnType<typeof import('./homeMachines.mjs').createHomeMachines>} o.machines
 * @param {{ get: (key: string) => string | null, set: (key: string, chatId: string) => Promise<unknown>, delete: (key: string) => Promise<unknown> }} o.keys
 * @param {{ get: (chatId: string) => import('../../../shared/momoTasks/types.ts').SessionEvent | null, set: (chatId: string, event: import('../../../shared/momoTasks/types.ts').SessionEvent) => Promise<unknown> }} o.ends
 * @param {(machineId: string, chatId: string, event: import('../../../shared/momoTasks/types.ts').SessionEvent) => unknown} o.emit
 * @param {(message: string) => void} o.report
 * @param {() => string} [o.newId]
 */
export function createRemoteMachine({ client, machines, keys, ends, emit, report, newId = () => crypto.randomUUID() }) {
  const reader = createTurnReader();
  /** The tracked chats that wait on the person's approval now. @type {Set<string>} */
  const waiting = new Set();
  /** @param {unknown} error */
  const said = (error) => (error instanceof Error ? error.message : String(error));

  /** What a chat's journal frame says: a turn that ended is how the session ended; an approval card opened or closed is `needs_you` or `resumed`. @param {{ id: string, name: string }} machine @param {string} chatId */
  const onEvent = (machine, chatId) => (/** @type {any} */ event) => {
    if (event?.event !== 'frame') return;
    const frame = event.frame;
    if (frame?.t === 'durable' && frame.item?.t === 'event') {
      const read = reader.read(chatId, frame.item.event);
      if (!read) return;
      waiting.delete(chatId);
      const end = read.end;
      if (end)
        Promise.resolve(ends.set(chatId, end))
          .then(() => emit(machine.id, chatId, end))
          .catch((error) => report(`MoMo task event for ${chatId}: ${said(error)}`));
    } else if (frame?.t === 'state' && reader.has(chatId)) {
      const wait = waitingIn(frame.patch);
      if (wait === true && !waiting.has(chatId)) {
        waiting.add(chatId);
        Promise.resolve(
          emit(machine.id, chatId, {
            kind: 'needs_you',
            line: `Waiting for your approval on ${machine.name}`,
            cardId: `approval:${chatId}`,
          }),
        ).catch((error) => report(`MoMo task event for ${chatId}: ${said(error)}`));
      } else if (wait === false && waiting.delete(chatId))
        Promise.resolve(emit(machine.id, chatId, { kind: 'resumed' })).catch((error) =>
          report(`MoMo task event for ${chatId}: ${said(error)}`),
        );
    }
  };

  /** Follow a chat's frames from the start of its journal, so a turn that ended meanwhile is read again. @param {import('./homeMachines.mjs').HomeMachine} machine @param {string} chatId */
  async function follow(machine, chatId) {
    reader.track(chatId);
    await client.listen(machine, chatId, onEvent(machine, chatId));
    await client.call(machine, 'chat.subscribe', { chatId, epoch: EPOCH, fromRev: 0 });
  }

  return {
    /** A chat of a task that is working now (found again after a restart). @param {string} chatId */
    track: (chatId) => reader.track(chatId),
    /** @param {string} chatId @param {string} [machineId] */
    untrack(chatId, machineId) {
      reader.untrack(chatId);
      waiting.delete(chatId);
      if (machineId) void client.unlisten(machineId, chatId);
    },
    size: () => reader.size(),
    /** The port the task manager takes, over every machine the owner allowed. @returns {import('../../../shared/momoTasks/types.ts').MachinePort} */
    port() {
      return {
        list: () =>
          Promise.all(
            machines.list().map(async (m) => {
              if (m.needsAllow)
                return { machineId: m.id, name: m.name, online: true, outdated: false, installable: false, agents: [], needsAllow: true };
              try {
                const status = await client.call(m, 'host.status', {});
                return {
                  machineId: m.id,
                  name: m.name,
                  online: true,
                  outdated: false,
                  installable: false,
                  agents: agentsFromStatus(status?.harnesses ?? [], m.name),
                };
              } catch {
                return { machineId: m.id, name: m.name, online: false, outdated: false, installable: false, agents: [] };
              }
            }),
          ),
        start: async (req) => {
          const machine = machines.get(req.machineId);
          // a machine whose key was not registered again after a move waits for the owner's device ("Allow again")
          if (!machine || machine.needsAllow)
            return { ok: false, code: START_CODE.machineNotAllowed, message: "MoMo isn't allowed to use that machine." };
          const agent = /** @type {string} */ (agentOfKind(req.harness));
          const hold = holdFor(agent, { readOnly: req.readOnly });
          // a machine only takes the two safe modes from MoMo; an agent that cannot be held to one is not started there
          if ('unsupported' in hold) return { ok: false, code: START_CODE.readOnlyUnsupported, message: hold.unsupported };
          // the same key is the same chat: the machine's own ledger answers a repeat of the start
          const chatId = keys.get(req.key) ?? hostChatId(`${appIdPrefix(agent)}${newId()}`);
          await keys.set(req.key, chatId);
          try {
            await client.call(machine, 'chat.start', {
              chatId,
              epoch: EPOCH,
              key: keyOf(req.key),
              text: req.brief,
              harness: req.harness,
              permission: hold.mode,
            });
          } catch (error) {
            const e = /** @type {any} */ (error);
            // the connection was lost after the request went: the machine may have started it, so the key stays and a retry sends the same chat and wire key, which it answers as a repeat
            if (e.code !== 'machine_lost') await keys.delete(req.key);
            return { ok: false, code: e.code, message: clean(said(error)), ...(e?.details ? { details: e.details } : {}) };
          }
          // the session runs on that machine now: the key stays, so a start again finds it, and a lost link is followed again by the next look (probe)
          await follow(machine, chatId).catch((error) => report(`MoMo task ${chatId} could not be followed yet: ${clean(said(error))}`));
          return { ok: true, sessionId: chatId };
        },
        stop: async (machineId, chatId) => {
          const machine = machines.get(machineId);
          if (machine) await client.call(machine, 'chat.stop', { chatId, epoch: EPOCH, key: keyOf(`stop:${chatId}:${newId()}`) });
        },
        probe: async (machineId, chatId) => {
          const end = ends.get(chatId);
          if (end) return { state: 'ended', event: end };
          const machine = machines.get(machineId);
          if (!machine) return { state: 'gone' };
          try {
            // read again from the start of its journal: a turn that ended while MoMo was away is delivered as an event
            await follow(machine, chatId);
            return { state: 'running' };
          } catch (error) {
            const code = /** @type {any} */ (error)?.code;
            // that machine does not know the session (or no longer serves MoMo it): it is gone, not unreachable
            if (code === 'machine_not_allowed') return { state: 'gone' };
            return { state: 'unreachable' };
          }
        },
      };
    },
  };
}
