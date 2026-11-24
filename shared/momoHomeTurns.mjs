// The two intents about a turn of MoMo's chat on the home (shared/momoHomeReal.mjs): stop the turn that is running, and ask the home what it has of a message, so one in doubt is settled by what the Host says and nothing is sent blindly again.
import { IntentError } from './momoHomeApi.mjs';
import { turnAnswer } from './momoHomeView.mjs';

/**
 * The chat on a machine that MoMo's turns go to, and the epoch it is at now: the Host starts or finds it, the first agent that can think is the one, and every
 * request of the chat carries that epoch. It is asked each time (a chat that was handed over is at another epoch), never remembered.
 * @param {{ call: (machineId: string, method: string, params: object, ms: number) => Promise<any>, callMs: number }} o
 */
export function createChatOn({ call, callMs }) {
  return async (/** @type {import('./momoHomeView.mjs').MachineRecord} */ machine) => {
    const agent = machine.agents.find((a) => a.signedIn);
    if (!agent) throw new IntentError(`No agent is signed in on ${machine.name}.`);
    const made = await call(machine.id, 'host.momoChat', { harness: agent.id }, callMs);
    if (typeof made?.chatId !== 'string' || !Number.isSafeInteger(made.epoch))
      throw new IntentError(`${machine.name} could not start MoMo’s chat.`);
    return { chatId: made.chatId, epoch: /** @type {number} */ (made.epoch) };
  };
}

/**
 * @param {object} o
 * @param {(force?: boolean) => Promise<import('./momoHomeLook.mjs').Read>} o.read
 * @param {(machineId: string, method: string, params: object, ms: number) => Promise<any>} o.call one call to a Host, within its time
 * @param {(machine: any) => Promise<{ chatId: string, epoch: number }>} o.chatOn
 * @param {ReturnType<typeof import('./momoHomeMail.mjs').createMail>} o.mail
 * @param {{ status: number, call: number }} o.timeouts
 * @param {() => string} o.newId
 */
export function createTurns({ read, call, chatOn, mail, timeouts, newId }) {
  return {
    /** @param {{ turnId?: string }} i */
    async stop({ turnId }) {
      const home = (await read()).home;
      if (!home) throw new IntentError('MoMo isn’t running anywhere right now.');
      const chat = await chatOn(home.machine);
      await call(home.machine.id, 'chat.stop', { ...chat, key: `stop-${newId()}`, ...(turnId ? { turnId } : {}) }, timeouts.call);
    },
    /** What the home says of a message: it has it (settled), never saw it (the person may send it again), or cannot say. @param {{ turnId: string }} i */
    async check({ turnId }) {
      const home = (await read(true)).home;
      if (!home || home.status.home.state !== 'running') return { turn: turnAnswer({ ledger: null, homeRunning: false }) };
      let ledger = 'unknown';
      try {
        ledger = (await call(home.machine.id, 'host.momoTurn', { turnId }, timeouts.status))?.state ?? 'unknown';
      } catch {
        return { turn: turnAnswer({ ledger: null, homeRunning: false }) };
      }
      const turn = turnAnswer({ ledger, homeRunning: true });
      mail.checked(turnId, turn, ledger, home.status.home.homeId);
      return { turn };
    },
  };
}
