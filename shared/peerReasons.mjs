// What a person reads for each reason code peer messaging gives (a blocked delivery, a failed send, a capability that is
// off); the codes stay in the journal and the agent tools, the windows show only these lines.

export const PEER_REASONS = Object.freeze({
  // the receiving chat
  chat_unavailable: 'That chat isn’t available.',
  chat_deleted: 'That chat was deleted.',
  chat_archived: 'That chat is archived.',
  running_elsewhere: 'That chat is running somewhere else.',
  harness_crashed: 'That chat’s harness stopped.',
  harness_turned_off: 'That chat’s harness is turned off for now.',
  harness_unavailable: 'That chat’s harness isn’t available.',
  login_required: 'That chat’s harness needs a sign-in.',
  target_goal_paused: 'That chat’s goal is paused.',
  target_paused_by_user: 'That chat is paused.',
  target_pause_not_persisted: 'That chat’s pause couldn’t be saved.',
  approval_pending: 'That chat is waiting for an approval.',
  harness_switch_pending: 'That chat is switching harnesses.',
  adapter_capability_unavailable: 'That chat’s harness can’t take messages.',
  native_steer_unavailable: 'That chat’s harness can’t take messages mid-turn.',
  native_rejected: 'That chat’s harness didn’t accept the message.',
  tool_bridge_unavailable: 'Chat tools aren’t available for this harness.',
  tool_bridge_disabled: 'Chat tools are turned off for now.',
  // the journal and delivery
  journal_unavailable: 'Messages couldn’t be loaded. Restart MoPilot.',
  invalid_journal: 'Messages couldn’t be loaded. Restart MoPilot.',
  delivery_unknown_after_restart: 'MoPilot restarted before delivery was confirmed.',
  resume_required: 'Stopped by a restart. Resume to send it.',
  acknowledgement_not_persisted: 'Delivery couldn’t be saved.',
  delivery_still_unknown: 'Delivery is still unconfirmed.',
  receipt_verification_unavailable: 'Delivery can’t be checked for this harness.',
  missing_submission_record: 'Delivery couldn’t be recorded.',
  invalid_peer_dispatch: 'The message couldn’t be sent.',
  invalid_peer_identity: 'The message couldn’t be sent.',
  queued_input_missing: 'The message is no longer in the queue.',
  reply_failed: 'The reply couldn’t be sent.',
  reply_unavailable: 'This message can’t be replied to.',
  // a send or an action on one
  self_send: 'A chat can’t message itself.',
  invalid_body: 'The message is empty or too long.',
  invalid_request_id: 'The message couldn’t be sent.',
  invalid_request: 'The request couldn’t be read.',
  idempotency_conflict: 'A different message was already sent for this request.',
  send_not_authorized: 'Sending to that chat isn’t allowed.',
  send_budget_exhausted: 'Too many messages this turn.',
  queue_full: 'That chat’s queue is full.',
  message_missing: 'That message isn’t available.',
  message_unavailable: 'That message isn’t available.',
  cannot_cancel: 'This message can’t be cancelled now.',
  cannot_send_now: 'This message can’t be sent now.',
  cannot_resume: 'This message can’t be resumed.',
  cannot_approve: 'This message isn’t waiting for approval.',
  cannot_decline: 'This message isn’t waiting for approval.',
  // the receiving chat's hold, and the inbox guard
  held_mode_mismatch: 'The chats’ permissions differ, so it waits for approval.',
  held_mode_unknown: 'The sender’s permissions aren’t known, so it waits for approval.',
  hold_expired: 'Not approved in time.',
  peer_loop_cut: 'Stopped a message loop between chats.',
  peer_relay_runaway: 'Stopped a long relay between chats.',
  rate_limited: 'Too many messages to that chat. Wait a moment.',
  duplicate_message: 'The same message was just sent.',
  // reading another chat
  reference_reader_unavailable: 'That chat can’t be read.',
  invalid_source_window: 'This window can’t message for that chat.',
  invalid_references: 'The request couldn’t be read.',
  invalid_cursor: 'The request couldn’t be read.',
  invalid_transcript: 'That chat can’t be read.',
  transcript_changed: 'That chat changed. Try again.',
  switched_history_too_large: 'That chat’s history is too long to read.',
  unsupported_history_adapter: 'That chat’s history can’t be read.',
});

export const UNKNOWN_PEER_REASON = 'Couldn’t deliver the message.';

/** A reason code as its line; an unknown, absent or malformed one gets the generic line, never the code. */
export function peerReasonText(/** @type {unknown} */ code) {
  return typeof code === 'string' && Object.hasOwn(PEER_REASONS, code)
    ? PEER_REASONS[/** @type {keyof typeof PEER_REASONS} */ (code)]
    : UNKNOWN_PEER_REASON;
}
