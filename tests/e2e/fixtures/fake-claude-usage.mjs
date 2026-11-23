// Fresh CLI-shaped reset dates keep the fake Claude usage windows active for every test run.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Include the UTC year so a weekly window crossing New Year cannot look expired. */
function resetText(at) {
  const date = new Date(at);
  const hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} at ${hour % 12 || 12}:${minute}${hour < 12 ? 'am' : 'pm'} (UTC)`;
}

/** `full`: the login's plan windows are used up (a ".fake-usage-full" file in its folder), though no turn has been refused. */
export function fakeClaudeUsage(now = Date.now(), full = false) {
  if (full)
    return `Current session: 100% used · resets ${resetText(now + 5 * 3600_000)}\nCurrent week (all models): 41% used · resets ${resetText(now + 7 * 86400_000)}`;
  return `Current session: 12% used · resets ${resetText(now + 5 * 3600_000)}\nCurrent week (all models): 34% used · resets ${resetText(now + 7 * 86400_000)}`;
}
