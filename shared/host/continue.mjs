// What a continue on another Host refuses with, shared by the Host that refuses and the app that shows it (docs: design/host/index.html, package 3.1).

/** Why a continue did not happen. Each is a refusal with a reason, never a half-moved chat; `stale_epoch` and the directory and harness refusals come from the Host's own modules. */
export const CONTINUE_CODES = Object.freeze({
  /** Another continue of the chat is open: this one waits for it or gives up. */
  inFlight: 'continue_in_flight',
  /** A turn is running: stop it first. */
  turnRunning: 'turn_running',
  /** The target holds no such preparation (it expired, was reclaimed, or never existed). */
  notPrepared: 'not_prepared',
  /** The preparation is for another target than the commit names. */
  targetMismatch: 'target_mismatch',
  /** The chat was handed to another Host; `details` says which and at which epoch. */
  released: 'chat_released',
  /** The chat was continued elsewhere while this Host was away; it serves nothing for it now. */
  poisoned: 'chat_poisoned',
  /** The chat is prepared here but nobody told this Host its epoch yet. */
  notServing: 'not_serving',
  /** A preparation that started before a restart never settled; prepare again. */
  prepareUnsettled: 'prepare_unsettled',
  /** The same chat, the same source and target: nothing to continue. */
  sameHost: 'same_host',
  /** The target is not online. */
  targetOffline: 'target_offline',
  /** The user was asked about continuing without the source and said no. */
  lostHostDeclined: 'lost_host_declined',
  /** The user or the app gave up before the owner changed. */
  cancelled: 'continue_cancelled',
  /** The commit may or may not have happened; the next try settles it first. */
  commitUnsettled: 'commit_unsettled',
  /** The chat's owner changed under the continue (another window moved it). */
  ownerChanged: 'owner_changed',
  /** The agent the chat runs on is not installed on the target. */
  agentMissing: 'agent_missing',
  /** The agent is installed on the target but nothing signs it in there (no login, no lent key or lease); `details.hint` says how, as the machine's sign-in row does. */
  agentSignedOut: 'agent_signed_out',
});

/**
 * The feature a Host declares when it takes a continue for every family it can start a chat with (Claude Code, Codex and ACP), not ACP only. An older Host answers `harness_not_configured` for Claude Code and Codex, so an app that sees the feature missing says the machine is too old before the press.
 */
export const CONTINUE_FAMILIES_FEATURE = 'continueFamilies';

/**
 * What a continue's refusal says, by the fact that holds, in this Host's words (`{agent}` is the agent's name, `{machine}` is filled by the app that knows the machine's name; a Host says "this machine"). `harness_not_configured` is what an older Host answers for a family it cannot take at all.
 */
export const CONTINUE_REFUSAL_COPY = Object.freeze({
  agent_missing: "{agent} isn't installed on {machine}.",
  agent_signed_out: 'Sign in to {agent} on {machine}.',
  harness_not_configured: '{machine} is too old to take this chat. Update it.',
});

/** A continue that did not (or could not be known to) happen. `details` carries what the caller needs to recover, such as `{ targetHostId, epoch }` of a released chat. */
export class ContinueRefusal extends Error {
  /** @param {string} code one of CONTINUE_CODES @param {string} message safe to show @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContinueRefusal';
    this.code = code;
    this.details = details;
  }
}
