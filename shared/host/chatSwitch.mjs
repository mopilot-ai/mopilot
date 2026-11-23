// Moving a machine chat to another agent on the same machine (D13, #4278): the wire's feature name, the request's shape and the refusals a Host answers with, so the Mac, the phone and the Host read one contract.
import { credentialOf } from './logins.mjs';

/** The feature both ends declare before a switch is sent; a Host declares it only once it can settle one (host/src/protocol.mjs), so an older Host is refused, never sent a request it would drop. */
export const SWITCH_FEATURE = 'switch';

/** Why a Host refuses a switch, as the codes the app and the phone read and the short line each shows. `{agent}` and `{machine}` are filled by the caller. */
export const SWITCH_REFUSALS = Object.freeze({
  agent_missing: '{agent} is not installed on {machine}.',
  agent_signed_out: 'Sign in to {agent} on {machine} first.',
  switch_unavailable: '{agent} cannot take over this chat.',
});

/**
 * The params of `chat.switch`: the chat, the agent it moves to and, as at a start, the model, effort and credential the new agent runs with.
 * `harness` equal to the chat's own agent cancels a choice made earlier.
 * @param {{ effect: (p: any) => object, harnessOf: (v: unknown) => string, bad: (message: string) => Error }} kit
 */
export function switchParsers({ effect, harnessOf, bad }) {
  const word = (/** @type {unknown} */ v, /** @type {string} */ what) => {
    if (typeof v !== 'string' || !v || v.length > 200 || /[\u0000-\u001f]/.test(v)) throw bad(`Pick ${what}.`);
    return v;
  };
  return {
    'chat.switch': (/** @type {any} */ p) => ({
      ...effect(p),
      harness: harnessOf(p.harness),
      ...(p.model == null ? {} : { model: word(p.model, 'a model') }),
      ...(p.effort == null ? {} : { effort: word(p.effort, 'an effort') }),
      // an older Host would drop it and the chat would run on another credential: a Host without `logins` is never sent one (requireFeatures)
      ...(p.credential == null ? {} : { credential: credentialOf(p.credential, bad) }),
    }),
  };
}
