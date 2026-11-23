// What a continue to this Host asks of its agents (#4906): the harness a chat names, spelled as the Host starts it, and the fact that holds when the Host cannot take it (not installed, signed out, or not an agent this Host knows).
import { ContinueRefusal, CONTINUE_CODES as C, CONTINUE_REFUSAL_COPY } from './continue.mjs';
import { agentLabel } from './agentReadiness.mjs';
import { agentOfKind, hostFamilyOfHarness } from './chatIds.mjs';
import { parseKind } from '../harnessKind.mjs';

/**
 * The harness a continue means. A chat that lives on a Host is drawn on the app as an ACP chat (`acp:host-claude:<id>`, shared/host/chatIds.mjs), and the app names its harness by that spelling; the Host starts it as the family it is.
 * @param {string} harness
 */
export function canonicalHarness(harness) {
  const basic = parseKind(harness)?.basic;
  return (basic && hostFamilyOfHarness(basic)) || harness;
}

/** How long one reading of the machine's agents serves the checks of a continue. */
const ROWS_TTL_MS = 3000;

/** @param {keyof typeof CONTINUE_REFUSAL_COPY} code @param {string} agent */
const said = (code, agent) => CONTINUE_REFUSAL_COPY[code].replace('{agent}', agent).replace('{machine}', 'this machine');

/**
 * Refuses a continue the Host cannot take, by the fact that holds. Installed and signed in, or installed with a key the app lends (`keyed`), is ready.
 * @param {object} o
 * @param {() => Promise<{ id: string, detected: boolean, signedIn: boolean, keyed?: boolean, unsure?: boolean, signIn?: string[], reason?: string }[]>} o.rows the machine's agents as its status reports them
 * @param {() => string[]} o.acpIds the basic agents this Host can start
 * @param {() => number} [o.now]
 * @returns {(harness: string) => Promise<void>}
 */
export function createAgentCheck({ rows, acpIds, now = Date.now }) {
  // the machine's status is asked for once per continue: a prepare's checks within a few seconds share one reading
  /** @type {{ at: number, read: ReturnType<typeof rows> } | null} */
  let held = null;
  const reading = () => {
    if (!held || now() - held.at > ROWS_TTL_MS) held = { at: now(), read: rows() };
    return held.read;
  };
  return async (harness) => {
    const kind = parseKind(canonicalHarness(harness));
    // an agent that is no kind of agent, or a basic one this Host has not set up: not a fact about the machine's install
    if (!kind || (kind.basic !== null && !acpIds().includes(kind.basic)))
      throw new ContinueRefusal('harness_not_configured', `This host has no ${harness} agent set up.`);
    const id = /** @type {string} */ (agentOfKind(canonicalHarness(harness)));
    const agent = agentLabel(id);
    const row = (await reading()).find((h) => h.id === id);
    if (!row?.detected) throw new ContinueRefusal(C.agentMissing, said('agent_missing', agent), { agent });
    // only a key the app lends with the chat's messages (`keyed`) stands in for a sign-in here; one that merely exists on the Host is not this chat's
    if (!row.signedIn && !row.keyed && !row.unsure) {
      const hint = (row.signIn ?? []).slice(0, 3).join(' or ');
      throw new ContinueRefusal(C.agentSignedOut, said('agent_signed_out', agent), {
        agent,
        ...(hint ? { hint } : {}),
        // the agent's login was refused (not merely absent): the app says so
        ...(row.reason === 'login-refused' ? { refused: true } : {}),
      });
    }
  };
}
