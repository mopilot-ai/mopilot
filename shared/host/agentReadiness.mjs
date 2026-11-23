// What a machine's agents are ready for, from the harnesses its Host reports: the menu offers the agents that are ready and says why the others are not, so one agent signed out never hides the machine.
import { machineModels } from './models.mjs';
import { loginsOf } from './logins.mjs';

export { loginsOf };
import { ACP_CATALOG } from '../harnessCatalog.mjs';
import { HARNESS_LABEL } from '../handoff.mjs';

/** The name the user knows an agent by: Claude Code and Codex, a basic agent by its catalog label, any other by its id. @param {string} id */
export const agentLabel = (id) => HARNESS_LABEL[id] ?? ACP_CATALOG[id]?.label ?? id;

/** The agents a machine has (installed, signed in or not), for the one-line note of its row: a Host lists every harness it knows. @param {{ id: string, detected: boolean }[]} harnesses */
export const installedIds = (harnesses) =>
  harnesses
    .filter((h) => h.detected)
    .map((h) => agentLabel(h.id))
    .join(', ');

/**
 * The line under an agent that is not installed, one wording for This Mac's picker and a machine's: where to install it. `settings` names the page where this Mac's path for it is set; a machine has none.
 * @param {string} label @param {{ machine?: string, settings?: string }} where
 */
export const missingHint = (label, where) =>
  where.machine ? `Install ${label} on ${where.machine}.` : `Install ${label}, or set its path in ${where.settings}.`;

/** Why the Host says an installed agent reads as signed out, in the person's words; '' when it gave no reason it knows. @param {unknown} reason @param {string} machine @param {string} agent */
const signedOutWhy = (reason, machine, agent) =>
  reason === 'keychain-locked'
    ? `${machine}'s keychain is locked. Log in on its screen once, or sign in again.`
    : reason === 'login-refused'
      ? `${agent} on ${machine} can't run: its login is refused. Sign in again on ${machine}.`
      : '';

/** The line for an installed agent that is signed out: which login the agent itself lists when the Host said, else only where to sign in. @param {unknown} methods @param {string} machine */
const signInLine = (methods, machine) => {
  const names = Array.isArray(methods) ? methods.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim().slice(0, 60)) : [];
  return names.length ? `Sign in on ${machine}: ${names.slice(0, 3).join(' or ')}` : `Sign in on ${machine}`;
};

/**
 * Each reported agent as 'ready' (installed and signed in), 'signin' (installed, signed out) or 'missing', with the line that says why it is not ready.
 * @param {{ id: string, detected: boolean, signedIn: boolean, reason?: string, signIn?: string[], checking?: boolean, unsure?: boolean, keyed?: boolean, models?: unknown, planMode?: true, logins?: unknown, using?: 'own' | 'key' | 'org', sources?: { own: boolean, key: boolean, org: boolean }, loginsSupported?: boolean, loginAccount?: { name?: string, plan?: string } }[]} harnesses @param {string} machine the machine's name
 * @returns {{ id: string, label: string, state: 'ready' | 'signin' | 'missing', reason: string, unsure?: true, lent?: true, using?: 'own' | 'key' | 'org', sources?: { own: boolean, key: boolean, org: boolean }, loginsSupported?: boolean, loginAccount?: { name?: string, plan?: string }, planMode?: true, models?: import('./models.mjs').MachineModel[] }[]}
 */
export function agentsOf(harnesses, machine) {
  return harnesses.map((h) => {
    // `keyed`: the user gave a key this agent runs with (electron/host/remoteCredentials.cjs), so it needs no sign-in on the machine
    // `unsure`: the Host could not tell for good (its CLI never answered): the agent stays usable and a send reports the real cause
    const unsure = h.detected && !h.signedIn && !h.keyed && h.unsure === true;
    const state = !h.detected ? 'missing' : h.signedIn || h.keyed || unsure ? 'ready' : 'signin';
    const reason = unsure
      ? `Couldn’t check ${agentLabel(h.id)} on ${machine}`
      : state === 'ready'
        ? ''
        : state === 'signin'
          ? signedOutWhy(h.reason, machine, agentLabel(h.id)) ||
            (h.checking === true ? `Checking on ${machine}…` : signInLine(h.signIn, machine))
          : `Not installed on ${machine}`;
    // `lent`: ready only because this Mac lends it a key or a lease with each message, so a run there needs this Mac online
    return {
      id: h.id,
      label: agentLabel(h.id),
      state,
      reason,
      ...(unsure ? { unsure: true } : {}),
      ...(Array.isArray(h.models) ? { models: machineModels(h.models) } : {}),
      // the logins the agent has on the machine (Claude Code today): which one it runs on, with its standing and usage
      ...(Array.isArray(h.logins) ? { logins: loginsOf(h.logins) } : {}),
      ...(state === 'ready' && !h.signedIn && !unsure ? { lent: true } : {}),
      // what a chat started now would use, and what else exists (a Host that reports them; shared/host/logins.mjs)
      ...(h.using ? { using: h.using } : {}),
      ...(h.sources ? { sources: h.sources } : {}),
      ...(typeof h.loginsSupported === 'boolean' ? { loginsSupported: h.loginsSupported } : {}),
      // the Host takes `plan` for this agent through `chat.permit` (a Host without it says nothing, and Plan stays off for the chat)
      ...(h.planMode === true ? { planMode: true } : {}),
      // which login the agent runs on there, as its CLI records it (a name and a plan, never a token); an older Host says none
      ...(h.loginAccount && typeof h.loginAccount === 'object' ? { loginAccount: h.loginAccount } : {}),
    };
  });
}
