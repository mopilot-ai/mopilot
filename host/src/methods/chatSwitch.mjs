// The Host's handler for `chat.switch` (feature `switch`): the person's choice to move a chat to another agent on this machine. It is held on the chat and settles with the chat's next message, as a local switch does; a choice that cannot be honored is refused here with a short reason, never held and never a silent no-op.
import { HostRefusal } from '../hostFs.mjs';
import { UnsupportedError } from '../errors.mjs';
import { agentLabel } from '../../../shared/host/agentReadiness.mjs';
import { SWITCH_REFUSALS } from '../../../shared/host/chatSwitch.mjs';

const say = (/** @type {string} */ code, /** @type {string} */ agent) =>
  new HostRefusal(
    code,
    SWITCH_REFUSALS[/** @type {keyof typeof SWITCH_REFUSALS} */ (code)].replace('{agent}', agent).replace('{machine}', 'this machine'),
  );

/**
 * @param {object} deps what the protocol was given
 * @param {{ switching?: boolean, switchState?: (chatId: string) => { harness: string } | null, choose?: (chatId: string, pending: object | null) => void }} deps.runtime
 *   `switching`: this runtime can settle a switch; `switchState`: the agent the chat runs on now (null: no such chat); `choose`: hold the choice on the chat, or drop it (null)
 * @param {(params?: object) => Promise<{ harnesses?: { id: string, detected: boolean, signedIn: boolean, keyed?: boolean, unsure?: boolean, sources?: { key?: boolean, org?: boolean } }[] }> | { harnesses?: { id: string, detected: boolean, signedIn: boolean, keyed?: boolean, unsure?: boolean, sources?: { key?: boolean, org?: boolean } }[] }} deps.status
 */
export default ({ runtime, status }) => ({
  effects: {
    /** @param {{ chatId: string, harness: string, model?: string, effort?: string, credential?: { source: string, login?: string } }} p */
    async 'chat.switch'(p) {
      if (!runtime.switching) throw new UnsupportedError('This host cannot move a chat to another agent yet. Update it.');
      const now = /** @type {NonNullable<typeof runtime.switchState>} */ (runtime.switchState)(p.chatId);
      if (!now) throw new HostRefusal('chat_unknown', 'This machine has no such chat.');
      // back to the agent the chat is on: the choice made earlier is dropped
      if (p.harness === now.harness) {
        /** @type {NonNullable<typeof runtime.choose>} */ (runtime.choose)(p.chatId, null);
        return { pending: null };
      }
      // the wire names a basic agent `acp:<id>`; the machine's own status lists it by its bare id
      const id = p.harness.startsWith('acp:') ? p.harness.slice(4) : p.harness;
      const agent = agentLabel(id);
      const known = (await status()).harnesses?.find((h) => h.id === id);
      if (!known?.detected) throw say('agent_missing', agent);
      // a key or an organization lease the app lent counts as a sign-in (the Host's own credential report), as in the machine's row
      if (!known.signedIn && !known.unsure && !known.keyed && !known.sources?.key && !known.sources?.org)
        throw say('agent_signed_out', agent);
      const pending = {
        harness: p.harness,
        model: p.model ?? '',
        modelLabel: p.model ?? '',
        mode: 'auto',
        ...(p.effort ? { effort: p.effort } : {}),
        ...(p.credential ? { credential: p.credential } : {}),
      };
      /** @type {NonNullable<typeof runtime.choose>} */ (runtime.choose)(p.chatId, pending);
      return { pending: { harness: pending.harness, ...(p.model ? { model: p.model } : {}) } };
    },
  },
});
