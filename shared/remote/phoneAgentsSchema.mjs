// A phone's requests for what a machine row offers (Remote Run, #5439): install a missing agent, sign in to one, update the Host, and read how the install and the sign-in stand. Parsers only; the Mac runs them through electron/app/hostPhone.cjs `agents`.
/** An agent as a machine's row names it (`claude`, `codex`, a basic agent's id). */
const AGENT = /^[\w.-]{1,64}$/;
/** One line typed for a sign-in under way (the code its page asks to be pasted back). */
const MAX_SIGNIN_INPUT = 1024;

/** @param {{ bad: (message: string) => Error, machineOf: (v: unknown) => string }} o */
export function phoneAgentParsers({ bad, machineOf }) {
  const agentOf = (/** @type {unknown} */ v) => {
    if (typeof v !== 'string' || !AGENT.test(v)) throw bad("That agent isn't one this machine lists.");
    return v;
  };
  const one = (/** @type {any} */ p) => ({ id: machineOf(p.id), harness: agentOf(p.harness) });
  return {
    'machines.install': one,
    'machines.installCancel': one,
    'machines.signIn': one,
    'machines.signInInput': (/** @type {any} */ p) => {
      if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > MAX_SIGNIN_INPUT) throw bad('Type the code the page shows.');
      return { ...one(p), text: p.text };
    },
    'machines.signInCancel': one,
    'machines.agentStatus': one,
    'machines.update': (/** @type {any} */ p) => ({ id: machineOf(p.id) }),
  };
}
