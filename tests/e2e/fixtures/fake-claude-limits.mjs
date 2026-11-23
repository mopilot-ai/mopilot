// The fake Claude CLI's turns on a login that can't serve them: out of usage (a rejected rate limit), a lapsed token
// (authentication_failed) or an organization the provider refuses (403 oauth_not_allowed_for_organization), each ending the turn as the real CLI does, with an error message and an error result.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TEXT = {
  limit: 'Claude AI usage limit reached',
  expired: 'Failed to authenticate. API Error: 401 OAuth token has expired. Please run /login',
  blocked:
    'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
};
/** The assistant message `error` the CLI gives each. */
const ERROR = { limit: 'rate_limit', expired: 'authentication_failed', blocked: 'oauth_org_not_allowed' };

/**
 * @param {{ send: (msg: object) => void, record: (type: string, extra: object) => void, sessionId: string }} cli
 * @param {number} started when the turn started
 * @param {'limit' | 'expired' | 'blocked'} why
 */
export function refusedTurn(cli, started, why) {
  const base = { parent_tool_use_id: null, session_id: cli.sessionId };
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (why === 'limit') {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    cli.send({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt },
      ...base,
      uuid: randomUUID(),
    });
  }
  const message = {
    id: `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    type: 'message',
    role: 'assistant',
    model: '<synthetic>',
    content: [{ type: 'text', text: TEXT[why] }],
    stop_reason: 'stop_sequence',
    stop_sequence: '',
    usage,
  };
  const uuid = randomUUID();
  cli.record('assistant', { message, uuid, isApiErrorMessage: true, error: ERROR[why] });
  cli.send({ type: 'assistant', message, error: ERROR[why], ...base, uuid });
  cli.send({
    type: 'result',
    subtype: 'success',
    is_error: true,
    duration_ms: Date.now() - started,
    duration_api_ms: 0,
    num_turns: 1,
    result: TEXT[why],
    stop_reason: 'stop_sequence',
    session_id: cli.sessionId,
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
  });
}

/**
 * Whether the login's folder holds a ".fake-usage-windows" file: its ordinary turns then report every plan window, as a
 * newer CLI does, with the extra-usage window it lists beside them (`seven_day_overage_included`).
 * @param {string} configDir
 */
export function reportsUsageWindows(configDir) {
  try {
    return fs.lstatSync(path.join(configDir, '.fake-usage-windows')).isFile();
  } catch {
    return false;
  }
}

/** The allowed rate_limit_event of such a turn. */
export function usageWindowsEvent(sessionId) {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const unifiedWindows = {
    five_hour: { utilization: 0.31, resetsAt },
    seven_day: { utilization: 0.35, resetsAt: resetsAt + 86400 },
    seven_day_overage_included: { utilization: 0, resetsAt: resetsAt + 86400 },
  };
  return {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.31, resetsAt, unifiedWindows },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  };
}

/** The rate_limit_events a turn's text asks for: "WARN" (five-hour window nearly used up), "WARN7D" (weekly), "WARNCLEAR" (allowed again, both windows), as the CLI reports them. [] for no such word. */
export function warningEvents(sessionId, text) {
  const asked = /\bWARN(7D|CLEAR)?\b/.exec(text);
  if (!asked) return [];
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const infos =
    asked[1] === 'CLEAR'
      ? ['five_hour', 'seven_day'].map((rateLimitType) => ({ status: 'allowed', rateLimitType, utilization: 0.2, resetsAt }))
      : [
          {
            status: 'allowed_warning',
            rateLimitType: asked[1] === '7D' ? 'seven_day' : 'five_hour',
            utilization: 0.9,
            resetsAt,
            surpassedThreshold: 0.9,
          },
        ];
  return infos.map((rate_limit_info) => ({
    type: 'rate_limit_event',
    rate_limit_info,
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  }));
}

/**
 * A request the model refused ("REFUSE"): the CLI's error reply with the API's stop reason `refusal`, and a failed result, as it
 * reports one when no fallback model takes the request over: the structured notice, the error reply, a failed result.
 * @param {{ send: (msg: object) => void, record: (type: string, extra: object) => void, sessionId: string }} cli
 * @param {number} started when the turn started
 */
export function refusedRequest(cli, started) {
  const base = { parent_tool_use_id: null, session_id: cli.sessionId };
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const text = 'Claude is unable to respond to this request, which appears to violate our Usage Policy. Please start a new chat.';
  const message = {
    id: `msg_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    type: 'message',
    role: 'assistant',
    model: '<synthetic>',
    content: [{ type: 'text', text }],
    stop_reason: 'refusal',
    stop_sequence: null,
    usage,
  };
  // the SDK's structured notice first (no fallback model retried the request), then the error reply
  cli.send({
    type: 'system',
    subtype: 'model_refusal_no_fallback',
    original_model: 'fake-model',
    request_id: null,
    api_refusal_category: null,
    api_refusal_explanation: null,
    refused_user_message_uuid: null,
    content: text,
    ...base,
    uuid: randomUUID(),
  });
  const uuid = randomUUID();
  cli.record('assistant', { message, uuid, isApiErrorMessage: true, error: 'invalid_request' });
  cli.send({ type: 'assistant', message, error: 'invalid_request', ...base, uuid });
  cli.send({
    type: 'result',
    subtype: 'success',
    is_error: true,
    duration_ms: Date.now() - started,
    duration_api_ms: 0,
    num_turns: 1,
    result: text,
    stop_reason: 'refusal',
    session_id: cli.sessionId,
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
  });
}
