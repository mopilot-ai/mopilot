// A credential-free, local-machine-only usage projection; account drivers and Claude's schedule remain the quota owners.
const { parseUsageText } = require('../../shared/claudeUsageText.mjs');
const { USAGE_READ_FRESH_MS } = require('../../shared/claudeRateLimit.mjs');

/** Codex's windows, without raw provider records, credentials or error strings. */
function codexWindows(limits) {
  return [limits?.primary, limits?.secondary].flatMap((w) => {
    if (!w) return [];
    const mins = w.windowDurationMins;
    const label = !mins
      ? 'Limit'
      : mins < 60
        ? `${mins}m`
        : mins <= 300
          ? `${Math.round(mins / 60)}h`
          : mins >= 10000
            ? 'Weekly'
            : `${Math.round(mins / 1440)}d`;
    return [{ label, usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null }];
  });
}

/** Window-by-window measurement order: live data never becomes younger merely because a phone asked for it. */
function claudeReading(r) {
  const parsed = r.state === 'success' ? parseUsageText(r.text, r.measuredAt) : null;
  const windows = new Map();
  for (const reading of [parsed, r.live]) {
    for (const w of reading?.windows ?? []) {
      const at = w.at ?? reading.at;
      if (!windows.has(w.label) || windows.get(w.label).at <= at) windows.set(w.label, { ...w, at });
    }
  }
  return [...windows.values()];
}

/** Reading all local instances never queries Hosts or guesses that an ACP/key account has subscription quota. */
async function readPhoneUsage(live, claude, now = Date.now(), reason = 'surface') {
  const registry = live.identity;
  if (!registry) throw new Error('Accounts are not ready. Try again.');
  const validators = [];
  const accounts = await Promise.all(
    registry.instances().map(async (instance) => {
      const { harness, account, billing, status, label, active } = instance;
      const base = { harness, account, label: label ?? account, active, status, windows: [] };
      // Every row is checked at whole-response publication, including rows that finished before another account waited.
      const who = () =>
        claude
          .accounts()
          ?.view()
          .accounts.find((a) => a.id === account)?.serverId;
      const startedAs = harness === 'claude' ? who() : null;
      const credentialCurrent = harness === 'codex' ? registry.driver(harness).accounts?.usageRefresh.capture(account) : null;
      const current = () => {
        const next = registry.instances(harness).find((a) => a.account === account);
        return (
          !!next &&
          next.label === label &&
          next.billing === billing &&
          next.status === status &&
          (harness !== 'claude' || who() === startedAs) &&
          (!credentialCurrent || credentialCurrent())
        );
      };
      validators.push(current);
      if (status !== 'ok') return { ...base, state: status === 'expired' || status === 'signedOut' ? 'signin' : 'unavailable' };
      if (billing !== 'subscription' || !['claude', 'codex'].includes(harness)) return { ...base, state: 'unsupported' };
      let windows = [];
      let failed = false;
      try {
        if (harness === 'claude') {
          const r = await claude.readUsageResult(account, reason);
          if (r.state === 'retired' || (startedAs && r.account !== startedAs)) throw new Error('retired');
          windows = claudeReading(r);
          failed = r.state !== 'success';
        } else {
          const limits = await registry.driver(harness).usage(account, reason);
          windows = codexWindows(limits).map((w) => ({ ...w, at: limits.at }));
        }
      } catch {
        failed = true;
      }
      // Recheck Claude's credential identity even when the schedule completed with a retired/error answer.
      if (harness === 'claude' && failed) windows = [];
      return {
        ...base,
        state: windows.length ? 'available' : 'unavailable',
        windows: windows.map((w) => ({
          label: w.label,
          usedPercent: w.usedPercent,
          resetsAt: w.resetsAt ?? null,
          ...(w.resetsText ? { resetsText: w.resetsText } : {}),
          at: w.at ?? 0,
          stale: !w.at || now - w.at > USAGE_READ_FRESH_MS,
        })),
      };
    }),
  );
  if (!validators.every((current) => current())) throw new Error('An account changed. Refresh usage to try again.');
  for (const a of accounts) a.active = registry.instances(a.harness).find((i) => i.account === a.account).active;
  return { scope: 'local', accounts };
}

module.exports = { readPhoneUsage };
