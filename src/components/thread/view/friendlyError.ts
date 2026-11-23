// Upstream error-message extraction, opaque rate-limit explanation, and model-unavailable recognition.

export function isBareRateLimit(msg: string) {
  return /^(?:Task terminated abnormally:\s*)?rate_limit\.?$/i.test(msg.trim());
}

/** Pull out the upstream message and explain otherwise opaque error codes. */
export function friendlyError(msg: string) {
  let message = msg;
  try {
    const j = JSON.parse(msg);
    message = j?.error?.message ?? j?.message ?? msg;
  } catch {
    const m = /"message"\s*:\s*"([^"]+)"/.exec(msg);
    message = m ? m[1] : msg;
  }
  if (isBareRateLimit(message)) return 'Out of usage or rate limited.';
  return message;
}

/**
 * A model the account can't use, as Codex ("The 'gpt-x' model is not supported when using Codex with a ChatGPT account",
 * "model_not_found"), Claude Code ("There's an issue with the selected model (claude-x). It may not exist or you may
 * not have access to it") and ACP agents ("Model not found", "model is not available") say it: the model's id when the
 * message names one, else null; undefined when the error is about something else.
 */
export function unavailableModel(msg: string): string | null | undefined {
  const m = msg.trim();
  const about =
    /model_not_found|issue with the selected model|model[^.\n]{0,80}?(?:not (?:supported|available|found|included|in your plan)|does not exist|isn['’]t available|(?:do|may) not have access)/i;
  if (!about.test(m)) return undefined;
  const named = /model[\s:]*[`'"(](\w[\w.:/@[\]-]*)[`'")]|[`'"(](\w[\w.:/@[\]-]*)[`'")]\s*model/i.exec(m);
  // the pattern sets exactly one of its two groups
  return named ? (named.slice(1).find(Boolean) as string) : null;
}

/** Whether a reply is the failure's own words again (whitespace aside; the error may say more around them, and a short reply is never taken for part of one). */
export function sameWords(reply: string | undefined, error: string | undefined) {
  const a = (reply ?? '').replace(/\s+/g, ' ').trim();
  const b = (error ?? '').replace(/\s+/g, ' ').trim();
  return a.length > 0 && (a === b || (a.length >= 30 && b.includes(a)));
}
