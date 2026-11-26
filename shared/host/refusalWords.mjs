// What a Host's refusal says to the person and what they can do about it, in one table for every client of a machine chat (the send queue, the Switch host dialog, the Mac's own start check): the cause in one sentence naming the machine and, when the agent is the cause, the agent; the one action that fixes it where the app has one; and whether sending the same message again can succeed.
import { CONTINUE_REFUSAL_COPY } from './continue.mjs';
import { agentLabel } from './agentReadiness.mjs';
import { hostPermissionFamily, isHostPermission } from './permissions.mjs';
import { SIDE_CHAT_PARENT_CHANGED_WORDS } from './sideChats.mjs';
import { PERMISSION_LABEL } from '../permissionMenu.mjs';
import { LINK_WORDS } from './refusalWordsLink.mjs';
import { CODE_PAIR_WORDS } from './refusalWordsCodePair.mjs';

/** the Host's names for the two modes the chip words differently */
const MODE_WORDS = { Default: PERMISSION_LABEL.default, 'Auto-review': PERMISSION_LABEL['auto-review'] };

/** The actions a refusal can offer in place; each is a call the app already has (install, a machine's sign-in, the organization's sign-in, a Host update). */
export const REFUSAL_ACTIONS = Object.freeze([
  'install',
  'signIn',
  'orgSignIn',
  'update',
  'openMachines',
  'newChat',
  'chooseFolder',
  'useMode',
]);

/**
 * @typedef {'install' | 'signIn' | 'orgSignIn' | 'update' | 'useMode'} RefusalAction
 * @typedef {{ line: string, action: RefusalAction | null, retry: boolean, mode?: string, named?: true }} RefusalWords `retry`: the same message (the same key, which the Host's ledger answers again unless the refusal is one it made before doing anything, host/src/ledger.mjs NOT_DONE) may be accepted once the cause is gone; false when the refusal is about this message or chat itself, or when the row says so itself after the cause clears (an agent installed or signed in)
 * @typedef {'ready' | 'signin' | 'missing' | null | undefined} AgentState how the machine's row says the chat's agent stands (shared/host/agentReadiness.mjs)
 * @typedef {object} RefusalContext
 * @property {string} machine the machine's name, as the person knows it
 * @property {string} [agent] the chat's agent (its id: `claude`, `codex`, a basic agent's id); named when the agent is the cause
 * @property {string} [message] the Host's own sentence, used where it is the only specific word (a policy, a spend limit, a storage fault)
 * @property {Record<string, unknown>} [details] what the refusal carried (`cause` of a credential refusal, `key` of a policy)
 * @property {AgentState} [agentState] how the agent stands now
 * @property {AgentState} [agentWas] how it stood when the Host refused: an agent that was missing and is ready now makes the refusal one to retry
 * @property {boolean} [installable] the machine's Host can install the agent itself
 * @property {boolean} [own] this app's own refusal of the message (an image it cannot send, a folder it cannot read), not a word from the machine: the sentence does not blame the machine and sending the same message again changes nothing
 * @property {'send' | 'continue'} [context] `continue`: a Switch host (an older Host's `harness_not_configured` there says the Host is too old for the chat's family); default `send`
 */

/** @param {string} template @param {string} machine @param {string} [agent] */
const fill = (template, machine, agent) =>
  template.replace('{agent}', agent ? agentLabel(agent) : 'The agent').replace('{machine}', machine);

/**
 * The Host's sentence with its own "this machine" named, or the machine put in front of a sentence that does not say it (a Switch host dialog already names its target, so it gets the sentence as it is); a Host that said nothing gets `fallback`.
 * @param {RefusalContext} c @param {string} fallback
 */
function said(c, fallback) {
  if (!c.message?.trim()) return fallback;
  const text = c.message.trim().replace(/\bthis (machine|host)\b/gi, c.machine);
  return text.includes(c.machine) || c.context === 'continue' || c.own ? text : `${c.machine}: ${text}`;
}

/** @param {RefusalContext} c */
const agentName = (c) => (c.agent ? agentLabel(c.agent) : 'The agent');

/**
 * The three facts the Host and the Mac both call `harness_not_configured`, told apart by how the agent stands: not installed there, installed and signed out, or neither (an older Host, or a row that is not current).
 * @param {string} code @param {RefusalContext} c @returns {RefusalWords}
 */
function agentFact(code, c) {
  const state = code === 'agent_missing' ? 'missing' : code === 'agent_signed_out' ? 'signin' : c.agentState;
  if (state === 'missing')
    return {
      line: fill(CONTINUE_REFUSAL_COPY.agent_missing, c.machine, c.agent),
      action: c.installable ? 'install' : null,
      retry: false,
    };
  if (state === 'signin') return { line: fill(CONTINUE_REFUSAL_COPY.agent_signed_out, c.machine, c.agent), action: 'signIn', retry: false };
  // the cause was fixed since (installed, signed in): the message can go now
  if (state === 'ready' && (c.agentWas === 'missing' || c.agentWas === 'signin'))
    return { line: `${agentName(c)} is ready on ${c.machine}.`, action: null, retry: true };
  if (c.context === 'continue')
    return { line: fill(CONTINUE_REFUSAL_COPY.harness_not_configured, c.machine, c.agent), action: 'update', retry: false };
  // the row cannot say which (or has not looked yet): the Host's own sentence is the specific one
  if (c.message?.trim()) return { line: said(c, ''), action: null, retry: true };
  return { line: `${agentName(c)} isn't set up on ${c.machine}.`, action: null, retry: true };
}

/** A credential the chat chose and the machine cannot use: by the Host's `details.cause`, else (an older Host) by what its sentence says. @param {RefusalContext} c @returns {RefusalWords} */
function credential(c) {
  const text = c.message ?? '';
  const cause =
    typeof c.details?.cause === 'string'
      ? c.details.cause
      : /organization/i.test(text)
        ? 'org'
        : /key from your Mac/i.test(text)
          ? 'key'
          : /one process/i.test(text)
            ? 'shared'
            : '';
  if (cause === 'org')
    return {
      line: `Your organization's access isn't available to ${agentName(c)} on ${c.machine}. Sign in to your organization.`,
      action: 'orgSignIn',
      retry: true,
    };
  if (cause === 'lease_in_use')
    return {
      line: `${c.machine} is using your organization's access, so this chat can't use the key from your Mac there.`,
      action: null,
      retry: true,
    };
  if (cause === 'other_signin')
    return {
      line: `This chat is open on another sign-in on ${c.machine}, so it can't use that credential yet. Start a new chat to use it.`,
      action: null,
      retry: false,
    };
  if (cause === 'key')
    return { line: `The key from your Mac isn't available to ${agentName(c)} on ${c.machine}.`, action: null, retry: true };
  if (cause === 'shared')
    return {
      line: `${agentName(c)} on ${c.machine} runs every chat in one process using what your Mac lent it, so this chat can't use the machine's own login yet.`,
      action: null,
      retry: false,
    };
  return { line: said(c, `The credential this chat uses isn't available on ${c.machine}.`), action: null, retry: false };
}

/**
 * The folder refusals: the Host's sentence says which folder and why, the machine is named. A message sent to a chat whose folder cannot be used goes on in a new chat in another folder on the machine ("Choose a folder"); the Switch host dialog has its own folder field, so it offers none. `pickable` false: the refusal is about a file, not a folder.
 * @param {string} fallback @returns {(c: RefusalContext) => RefusalWords}
 */
const folder =
  (fallback, retry = false, pickable = true) =>
  (c) => ({
    // the dialog's own sentences name the folder's problem exactly; a Host's say it for a send
    line: said(c.context === 'continue' ? { ...c, message: undefined } : c, fallback.replace('{machine}', c.machine)),
    action: pickable && c.context !== 'continue' ? 'chooseFolder' : null,
    retry,
  });

/** A fault in the machine's own storage: the Host says which, the machine is named, and sending again can succeed once the person has made room. @returns {(c: RefusalContext) => RefusalWords} */
const storage = () => (c) => ({
  line: said(c, `${c.machine} couldn't save this chat. Check its disk space and permissions.`),
  action: null,
  retry: true,
});

/** @type {Record<string, (c: RefusalContext) => RefusalWords>} every refusal a Host gives to a client of a machine chat, by its wire code */
/** The Host's own sentence, led by the machine it came from (the one specific word there is), else `fallback`. @param {RefusalContext} c @param {string} fallback */
const onMachine = (c, fallback) => (c.message?.trim() ? `${c.machine}: ${c.message.trim()}` : fallback);
/** A machine's name a refusal carried (`details.name`), else `fallback`. @param {RefusalContext} c @param {string} fallback */
const nameOf = (c, fallback) => (typeof c.details?.name === 'string' && c.details.name ? c.details.name : fallback);

const TABLE = {
  harness_not_configured: (c) => agentFact('harness_not_configured', c),
  agent_missing: (c) => agentFact('agent_missing', c),
  agent_signed_out: (c) => agentFact('agent_signed_out', c),
  // the credential the chat chose
  login_signed_out: (c) => ({
    line: `The login this chat uses for ${agentName(c)} is signed out on ${c.machine}.`,
    action: 'signIn',
    retry: true,
  }),
  login_unavailable: (c) => ({ line: `The login this chat uses isn't on ${c.machine} any more.`, action: null, retry: false }),
  login_removed: (c) => ({ line: `The login this chat uses was removed from ${c.machine}.`, action: null, retry: false }),
  login_limited: (c) => ({ line: `The login this chat uses is at its limit on ${c.machine}.`, action: null, retry: true }),
  credential_unavailable: credential,
  org_unavailable: (c) => ({ line: c.message?.trim() || "Your organization's sign-in service didn't answer.", action: null, retry: true }),
  org_signin_required: () => ({ line: 'Sign in to your organization to use its access.', action: 'orgSignIn', retry: false }),
  org_identity_busy: (c) => ({
    line: `${agentName(c)} on ${c.machine} is running another organization sign-in's turn. Send it again when that turn ends.`,
    action: null,
    retry: true,
  }),
  // the machine's owner's rules, in the Host's own words (they say which rule)
  // a mode above the owner's ceiling (`details.max`): the chat goes on under the most the machine allows, in one click; sending the same message again would be refused again
  policy_refused: (c) => {
    const max =
      c.details?.key === 'permissionMax' && isHostPermission(c.details.max) && hostPermissionFamily(c.agent ?? '')
        ? String(c.details.max)
        : null;
    // the modes are named as the chip names them (the Host's own word for the default is "Default", the chip's is "Ask for approval")
    const line = said(c, `${c.machine} doesn't allow this.`).replace(/\b(Default|Auto-review)\b/g, (name) => MODE_WORDS[name]);
    return max ? { line, action: 'useMode', retry: false, mode: max, named: true } : { line, action: null, retry: true };
  },
  spend_limit: (c) => ({
    line: `${c.message?.trim() || 'A spend limit holds this chat'} on ${c.machine}.`,
    action: null,
    retry: true,
  }),
  // access is granted, or the machine added again, on its page in Settings
  forbidden: (c) => ({ line: `${c.machine} doesn't let this Mac do that.`, action: 'openMachines', retry: false }),
  // the cause is the whole sentence, so the row does not front it with "Host did not accept it" (`named`); Pair again is the machine's page in Settings, where it is added again with its code
  // this Mac could not read its own key (a locked keychain): asked again by Retry and by the next message
  key_unreadable: (c) => ({
    line: `This Mac can't read its key for ${c.machine}. Unlock the keychain, then Retry.`,
    action: null,
    retry: true,
  }),
  unknown_client: (c) => ({ line: `${c.machine} doesn't know this Mac.`, action: 'openMachines', retry: true, named: true }),
  // the chat, the folder and the request itself
  // a chat that is gone from the machine: the words go on in a new chat there
  chat_unknown: (c) => ({ line: `${c.machine} has no such chat.`, action: 'newChat', retry: false }),
  session_journal_deleted: (c) => ({ line: `This chat was deleted from ${c.machine}.`, action: 'newChat', retry: false }),
  side_chat_parent_changed: () => ({ line: SIDE_CHAT_PARENT_CHANGED_WORDS, action: null, retry: false }),
  side_chat_starting: (c) => ({
    line: `${c.machine} is still preparing this side chat’s first message. Try again in a moment.`,
    action: null,
    retry: true,
  }),
  side_chat_fork_timeout: (c) => ({
    line: `${agentName(c)} on ${c.machine} took too long to open this side chat.`,
    action: null,
    retry: true,
  }),
  side_chat_started: (c) => ({
    line: `${c.machine} already accepted this side chat’s first message. Open it to continue.`,
    action: null,
    retry: false,
  }),
  directory_missing: folder("That folder doesn't exist on {machine}.", true),
  outside_roots: folder('That folder is outside what {machine} shares.'),
  outside_grant: folder('That folder is outside what {machine} shares.'),
  not_a_directory: folder("That isn't a folder on {machine}."),
  not_a_repository: folder("That folder isn't a git repository on {machine}."),
  not_a_file: folder("That isn't a file on {machine}.", false, false),
  invalid_path: folder("That path isn't valid on {machine}."),
  clone_failed: folder("{machine} couldn't clone the repository.", false, false),
  worktree_failed: folder("{machine} couldn't make the worktree.", false, false),
  mode_unavailable: (c) => ({
    line: `${agentName(c)} on ${c.machine} can't change to that mode: ${c.message?.trim() || 'it refused'}`,
    action: null,
    retry: false,
  }),
  unavailable: (c) => ({ line: said(c, `${c.machine} can't do that.`), action: null, retry: false }),
  image_fault: (c) => ({ line: said(c, `${c.machine} couldn't read the picture. Try again.`), action: null, retry: true }),
  image_unavailable: (c) => ({ line: said(c, `${c.machine} couldn't take the picture.`), action: null, retry: false }),
  // the Host is older than what the message needs
  feature_missing: (c) => ({
    line: said(c, `${c.machine} is too old for this. Update it.`),
    action: 'update',
    retry: true,
  }),
  version_refused: (c) => ({
    line: `This app and ${c.machine} are too far apart in version. Update the older one.`,
    action: 'update',
    retry: true,
  }),
  // what the Host would say for itself: its words are the only specific ones
  unsupported: (c) => ({ line: said(c, `${c.machine} can't do that.`), action: null, retry: !c.own }),
  invalid: (c) => ({ line: c.message?.trim() || `${c.machine} couldn't read that message.`, action: null, retry: false }),
  key_reused: (c) => ({ line: `${c.machine} already used this message for another request.`, action: null, retry: false }),
  not_supported: (c) => ({
    line: `${agentName(c)} on ${c.machine} has one sign-in, so there is no login to pick.`,
    action: null,
    retry: false,
  }),
  request_interrupted: (c) => ({
    line: `${c.machine} restarted during this request, so it may or may not have gone. Look at the chat before sending it again.`,
    action: null,
    retry: false,
  }),
  write_timed_out: (c) => ({
    line: `${c.machine} took too long to change that folder. Look at its changes before trying again.`,
    action: null,
    retry: false,
  }),
  read_timed_out: (c) => ({ line: `${c.machine} took too long to answer.`, action: null, retry: true }),
  // the machine's storage
  session_storage_unavailable: storage(),
  session_journal_full: storage(),
  session_journal_budget: storage(),
  session_journal_busy: storage(),
  session_journal_delete_failed: storage(),
  session_journal_unreadable: storage(),
  epoch_store_unreadable: storage(),
  owner_store_unreadable: storage(),
  // no summary can be made of a history the machine cannot read, so the way on is a fresh chat
  history_too_large: (c) => ({ line: `This chat is too long for ${c.machine} to read back.`, action: 'newChat', retry: false }),
  history_changed: (c) => ({ line: `This chat changed on ${c.machine} meanwhile.`, action: null, retry: true }),
  // the chat moved or the owner changed: the message goes to the machine that has it now
  stale_epoch: () => ({ line: 'This chat moved to another machine.', action: null, retry: false }),
  chat_released: () => ({ line: 'This chat moved to another machine.', action: null, retry: false }),
  owner_changed: () => ({ line: 'This chat moved to another machine.', action: null, retry: false }),
  // MoMo's Google source (host/src/momoGoogle.mjs); the person can fix each one from MoMo's Google settings
  google_api: (c) => ({ line: `Google could not answer ${c.machine} just now. MoMo will try again.`, action: null, retry: true }),
  google_not_configured: (c) => ({ line: `${c.machine} has no Google client set up yet.`, action: null, retry: false }),
  google_connected: (c) => ({ line: `Disconnect Google on ${c.machine} before changing its client.`, action: null, retry: false }),
  google_bad_client: (c) => ({ line: `${c.machine} could not use that Google client file.`, action: null, retry: false }),
  google_send_taken: (c) => ({ line: `Sending on ${c.machine} is already handed to the approval step.`, action: null, retry: false }),
  google_different_account: (c) => ({
    line: `Google on ${c.machine} is connected to another account. Disconnect it first to connect this one.`,
    action: null,
    retry: false,
  }),
  google_needs_sign_in: (c) => ({ line: `Google needs a new sign-in on ${c.machine}.`, action: null, retry: false }),
  google_not_connected: (c) => ({ line: `Google is not connected on ${c.machine}.`, action: null, retry: false }),
  google_failed: (c) => ({ line: `Google could not be used on ${c.machine} right now.`, action: null, retry: false }),
  google_superseded: (c) => ({
    line: `That Google sign-in was cut short because MoMo moved or was reset on ${c.machine}. Start it again.`,
    action: null,
    retry: false,
  }),
  google_wrong_account: (c) => ({
    line: `That is not the Google account MoMo on ${c.machine} is connected to.`,
    action: null,
    retry: false,
  }),
  google_audit_unavailable: (c) => ({
    line: `${c.machine} cannot write its audit log, so it does not change Google.`,
    action: null,
    retry: false,
  }),
  google_unavailable: (c) => ({ line: `${c.machine} could not reach Google.`, action: null, retry: true }),
  // MoMo's home, its turns and its main chat: the real cause, in a line. The one-click fix, where there is one, is the view's own (`fix {id, label}`),
  // shown beside this line; these words are also what any other surface (a chat's error, the phone's generic path, a log) falls back to
  momo_check_unavailable: (c) => ({ line: `MoMo on ${c.machine} has no model to check this with yet.`, action: null, retry: true }),
  momo_check_too_large: (c) => ({ line: `That is too long for MoMo on ${c.machine} to check.`, action: null, retry: false }),
  momo_check_malformed: (c) => ({ line: `MoMo on ${c.machine} got no usable answer when it checked this.`, action: null, retry: false }),
  momo_check_timeout: (c) => ({ line: `MoMo on ${c.machine} took too long to check this.`, action: null, retry: true }),
  momo_check_budget: (c) => ({ line: `MoMo on ${c.machine} has checked enough for this hour.`, action: null, retry: true }),
  momo_check_failed: (c) => ({ line: `MoMo on ${c.machine} couldn't check this right now.`, action: null, retry: true }),
  momo_chat_unavailable: (c) => ({ line: `MoMo's chat on ${c.machine} can't take this yet.`, action: null, retry: true }),
  momo_chat_fixed: (c) => ({ line: `MoMo's chat on ${c.machine} keeps its own settings, agent and place.`, action: null, retry: false }),
  momo_home_away: (c) => ({ line: `MoMo's home isn't running on ${c.machine}.`, action: 'openMachines', retry: true }),
  // MoMo's home on another of the user's machines (host/src/homeGate.mjs): what this machine says when the home asks for more than it may
  home_not_allowed: (c) => ({ line: `MoMo isn't allowed to do that on ${c.machine}.`, action: null, retry: false }),
  home_mode_refused: (c) => ({
    line: `MoMo may start tasks on ${c.machine} only in "Ask for approval" or read-only.`,
    action: null,
    retry: false,
  }),
  home_lease_jump: (c) => ({
    line: `${c.machine} doesn't believe MoMo's claim to a lease far ahead of the one it knows. Allow MoMo again if it really moved that far.`,
    action: null,
    retry: false,
  }),
  home_too_many: (c) => ({
    line: `MoMo already has as many tasks running on ${c.machine} as it may. Wait for one to finish.`,
    action: null,
    retry: false,
  }),
  home_mode_changed: (c) => ({
    line: `This session's mode was raised on ${c.machine}, so MoMo can no longer send to it.`,
    action: null,
    retry: false,
  }),
  home_handover_failed: (c) => ({
    line: `MoMo's key was added on ${c.machine}, but taking over its lease did not finish. Allow MoMo again.`,
    action: null,
    retry: false,
  }),
  home_lease_unassigned: (c) => ({
    line: `MoMo has no key allowed to hold its lease on ${c.machine}. Allow MoMo again from your own device.`,
    action: null,
    retry: false,
  }),
  home_lease_held: (c) => ({
    line: `Another MoMo key holds the lease on ${c.machine}. Allow MoMo again from your own device.`,
    action: null,
    retry: false,
  }),
  home_stamp_missing: (c) => ({ line: `${c.machine} can't tell which MoMo home this comes from.`, action: null, retry: false }),
  ...CODE_PAIR_WORDS,
  ...LINK_WORDS,
  home_state_unreadable: (c) => ({
    line: `MoMo's permissions on ${c.machine} can't be read, so MoMo is not allowed to use it until they are set again.`,
    action: null,
    retry: false,
  }),
  turn_id_required: (c) => ({
    line: `A message to MoMo on ${c.machine} needs its own id, so this one wasn't sent.`,
    action: null,
    retry: false,
  }),
  turn_busy: (c) => ({ line: `MoMo on ${c.machine} is still working on your last message.`, action: null, retry: true }),
  turn_conflict: (c) => ({ line: `That message belongs to another chat on ${c.machine}.`, action: null, retry: false }),
  momo_grant_lapsed: (c) => ({
    line: `MoMo's access has run out on ${c.machine}: open MoPilot on your account's device to renew it.`,
    action: null,
    retry: true,
  }),
  momo_unavailable: (c) => ({ line: `MoMo isn't available on ${c.machine} right now.`, action: null, retry: false }),
  momo_intent_unavailable: (c) => ({ line: `MoMo on ${c.machine} can't do that from a notification yet.`, action: null, retry: false }),
  momo_unknown_notification: (c) => ({ line: `That notification is not one MoMo on ${c.machine} sent.`, action: null, retry: false }),
  momo_bad_time: (c) => ({ line: `MoMo on ${c.machine} can't remind you at that time.`, action: null, retry: false }),
  momo_brief_in_quiet: (c) => ({
    line: `The brief time is inside quiet hours on ${c.machine}, so it would never be sent. Pick a time after they end, or change them.`,
    action: null,
    retry: false,
  }),
  momo_brain_unavailable: (c) => ({ line: onMachine(c, `This agent can't be MoMo's brain on ${c.machine}.`), action: null, retry: false }),
  momo_registry_unreadable: (c) => ({
    line: `MoMo's chats can't be read on ${c.machine}, so none was started.`,
    action: null,
    retry: false,
  }),
  momo_chat_not_started: (c) => ({ line: `MoMo's chat couldn't be set up on ${c.machine}.`, action: null, retry: true }),
  home_unavailable: (c) => ({
    line: `MoMo's home record on ${c.machine} can't be read, so it was left as it is.`,
    action: null,
    retry: false,
  }),
  home_exists: (c) => ({ line: `MoMo's home is ${nameOf(c, 'another machine')}, not ${c.machine}.`, action: 'openMachines', retry: false }),
  home_moved: (c) => ({ line: `MoMo moved from ${c.machine} to ${nameOf(c, 'another machine')}.`, action: 'openMachines', retry: false }),
  retired_copy_here: (c) => ({
    line: `${c.machine} still has an older MoMo. Use it or delete it first.`,
    action: 'openMachines',
    retry: false,
  }),
  retired_changed: (c) => ({ line: `The older MoMo on ${c.machine} changed, so nothing was deleted.`, action: null, retry: false }),
  floor_too_high: (c) => ({ line: `${c.machine} can't start MoMo above an epoch that far ahead in one step.`, action: null, retry: false }),
  floor_invalid: (c) => ({ line: `${c.machine} was given an epoch it can't use.`, action: null, retry: false }),
  epoch_limit: (c) => ({ line: `${c.machine} can't start a newer MoMo.`, action: null, retry: false }),
  epoch_unproven: (c) => ({
    line: `${c.machine} has no reason to believe that MoMo is newer, so it was left as it is.`,
    action: null,
    retry: false,
  }),
  home_not_here: (c) => ({ line: `${c.machine} isn't MoMo's home.`, action: 'openMachines', retry: false }),
  home_lease_stale: (c) => ({ line: `MoMo's home moved on while ${c.machine} was being asked.`, action: null, retry: true }),
  move_in_progress: (c) => ({ line: onMachine(c, `Another move of MoMo started on ${c.machine}.`), action: null, retry: false }),
  move_closed: (c) => ({ line: `That move of MoMo already ended on ${c.machine}.`, action: null, retry: false }),
  reclaim_not_owner: (c) => ({ line: `Only a paired device can decide that MoMo runs on ${c.machine} again.`, action: null, retry: false }),
  home_copy_missing: (c) => ({
    line: `MoMo's copy is no longer on ${c.machine}, so it can't run there again.`,
    action: null,
    retry: false,
  }),
  move_sealed: (c) => ({ line: `That move of MoMo was already sealed on ${c.machine}.`, action: null, retry: false }),
  move_discarded: (c) => ({ line: `That move was given up on ${c.machine}, so it can't go on.`, action: null, retry: false }),
  move_expired: (c) => ({ line: `That move took too long on ${c.machine}, so nothing was changed.`, action: null, retry: true }),
  move_unknown: (c) => ({ line: `${c.machine} isn't part of this move.`, action: null, retry: false }),
  move_not_given_up: (c) => ({
    line: `The other machine hasn't said it gave the move up, so MoMo stays paused on ${c.machine} until it does.`,
    action: null,
    retry: false,
  }),
  move_unavailable: (c) => ({ line: `MoMo's data on ${c.machine} can't be moved yet.`, action: null, retry: false }),
  receipt_invalid: (c) => ({
    line: `The other machine hasn't confirmed it took MoMo over, so nothing was deleted on ${c.machine}.`,
    action: null,
    retry: false,
  }),
  bundle_unreadable: (c) => ({
    line: `MoMo's copy couldn't be opened on ${c.machine}, so nothing was changed.`,
    action: null,
    retry: true,
  }),
  bundle_mismatch: (c) => ({
    line: `MoMo's copy isn't the one that was sealed, so nothing was changed on ${c.machine}.`,
    action: null,
    retry: true,
  }),
  bundle_too_large: (c) => ({ line: `MoMo's data on ${c.machine} is too large to move in one piece yet.`, action: null, retry: false }),
  // MoMo's server-signed entitlement (#5474): the Host's own cause for not taking the grant; the view's fix (Refresh access, Update the app) sits beside it
  entitlement_missing: (c) => ({
    line: `${c.machine} needs a signed MoMo entitlement and the app sent none.`,
    action: 'update',
    retry: false,
  }),
  entitlement_invalid: (c) => ({ line: `${c.machine} doesn't trust the MoMo entitlement it was sent.`, action: null, retry: false }),
  entitlement_unknown_key: (c) => ({
    line: `${c.machine} doesn't know the key that signed MoMo's entitlement; update MoPilot there.`,
    action: 'update',
    retry: false,
  }),
  entitlement_wrong_host: (c) => ({
    line: `The MoMo entitlement was made for another machine, not ${c.machine}.`,
    action: null,
    retry: false,
  }),
  entitlement_stale: (c) => ({
    line: `${c.machine} already has a newer MoMo entitlement than the one it was sent.`,
    action: null,
    retry: false,
  }),
  entitlement_expired: (c) => ({ line: `MoMo's access on ${c.machine} ran out and wasn't renewed.`, action: null, retry: false }),
  entitlement_revoked: (c) => ({ line: `MoMo access for this account was withdrawn on ${c.machine}.`, action: null, retry: false }),
  clock_skew: (c) => ({ line: `${c.machine}'s date or time looks wrong: check the clock.`, action: null, retry: false }),
  not_invited: (c) => ({ line: `This account isn't invited to MoMo on ${c.machine}.`, action: null, retry: false }),
  entitlement_unwritable: (c) => ({
    line: `${c.machine} couldn't save MoMo's access: check its disk space and permissions.`,
    action: null,
    retry: false,
  }),
  audit_chain_broken: (c) => ({
    line: `MoMo's audit log didn't check out on ${c.machine}, so nothing was changed.`,
    action: null,
    retry: false,
  }),
};

/** Every code the table words. */
export const REFUSAL_CODES = Object.freeze(Object.keys(TABLE));

/**
 * What a Host's refusal says and offers, or null for a code the table does not know (the caller shows the Host's own message, with Retry).
 * @param {string | undefined} code the wire code of the refusal
 * @param {RefusalContext} context
 * @returns {RefusalWords | null}
 */
export function refusalWords(code, context) {
  return code && Object.hasOwn(TABLE, code) ? TABLE[code](context) : null;
}
