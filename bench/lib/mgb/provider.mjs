// MoPilot 12-Grid Bench (#1381): a model provider's outage during a turn, read from a harness's own log (opencode's
// rate limits and header timeouts), so a run the provider refused is graded UNGRADABLE, never the agent's fail.

/** What a provider refusing or not answering looks like in a stream error. */
const OUTAGE = /rate limit|ProviderHeaderTimeoutError|\b429\b|Streaming response failed|overloaded/i;

/**
 * The provider errors a harness logged for the main agent between `from` and `to` (epoch ms), one entry per distinct
 * error. Reads opencode's log lines (`timestamp=… level=ERROR … message="stream error" … small=false … error…="…"`);
 * a title or summary request (`small=true`) is not the turn's model. With `sessions`, only those sessions' lines count:
 * another chat's rate limit in the same window is not this turn's.
 * @param {string} log the log text @param {{ from: number, to: number, sessions?: string[] }} window
 * @returns {string[]}
 */
export function providerErrors(log, { from, to, sessions }) {
  /** @type {Set<string>} */
  const seen = new Set();
  for (const line of log.split('\n')) {
    if (!line.includes('level=ERROR') || !line.includes('message="stream error"') || line.includes('small=true')) continue;
    const at = Date.parse(/^timestamp=(\S+)/.exec(line)?.[1] ?? '');
    if (!(at >= from && at <= to)) continue;
    if (sessions && !sessions.includes(/session\.id=(\S+)/.exec(line)?.[1] ?? '')) continue;
    const error = /error[.\w]*="([^"]*)/.exec(line)?.[1] ?? '';
    if (OUTAGE.test(error)) seen.add(error.slice(0, 160));
  }
  return [...seen];
}
