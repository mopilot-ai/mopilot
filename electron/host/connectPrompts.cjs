// ssh's questions while a machine is being added (sshAskpass.cjs), shown in the windows and answered there: only a machine being added may ask (a heartbeat, an update or a sign-in never prompts), each question takes one answer, and a question still open when its add ends is cancelled.

const { clock } = require('../platform/ports/clock.cjs');
const { normalAddress } = require('../../shared/host/sshDestination.mjs');

/** A question nobody answers (the window was closed, the person walked away) is cancelled after this, so the add it holds ends. */
const ANSWER_MS = 5 * 60_000;

/**
 * @typedef {{ id: string, destination: string, prompt: Omit<import('./sshAskpass.cjs').AskRequest, 'pause' | 'resume'> | null }} PromptEvent a question to show, or (`prompt` null) one that is answered or gone
 */

/** @param {{ broadcast: (event: PromptEvent) => void }} o */
function createConnectPrompts({ broadcast }) {
  /** Adds under way, by destination (a second request for the same machine joins the first). @type {Map<string, number>} */
  const adding = new Map();
  /** @type {Map<string, { destination: string, resolve: (answer: string | null) => void, timer: any }>} */
  const open = new Map();
  let next = 0;

  /** @param {string} id @param {string | null} answer */
  const settle = (id, answer) => {
    const q = open.get(id);
    if (!q) return false;
    open.delete(id);
    clock.clearTimeout(q.timer);
    q.resolve(answer);
    broadcast({ id, destination: q.destination, prompt: null });
    return true;
  };

  return {
    /** @param {import('./sshAskpass.cjs').AskRequest} q @returns {Promise<string | null>} */
    ask(q) {
      if (!adding.has(q.destination)) return Promise.resolve(null);
      const id = `prompt-${++next}`;
      const { pause: _pause, resume: _resume, ...prompt } = q;
      return new Promise((resolve) => {
        open.set(id, { destination: q.destination, resolve, timer: clock.setTimeout(() => settle(id, null), ANSWER_MS) });
        broadcast({ id, destination: q.destination, prompt });
      });
    },
    /** The window's answer; anything but a string cancels. False when the question is no longer open. @param {unknown} id @param {unknown} answer */
    answer: (id, answer) => settle(String(id), typeof answer === 'string' ? answer : null),
    /**
     * Runs `add` with ssh allowed to ask about `destination`; questions still open when it ends are cancelled.
     * @template T @param {string} typed @param {() => Promise<T>} add @returns {Promise<T>}
     */
    async during(typed, add) {
      const destination = normalAddress(typed); // ssh asks about the machine under its one normal address
      adding.set(destination, (adding.get(destination) ?? 0) + 1);
      try {
        return await add();
      } finally {
        const left = /** @type {number} */ (adding.get(destination)) - 1;
        if (left > 0) adding.set(destination, left);
        else {
          adding.delete(destination);
          for (const [id, q] of [...open]) if (q.destination === destination) settle(id, null);
        }
      }
    },
  };
}

module.exports = { createConnectPrompts };
