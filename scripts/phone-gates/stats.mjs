// DEV ONLY: the sample maths of the phone gates: the six gates and their limits, median and worst, the hitch ratio of a stream of frames, the trace rows of Settings › About, and the result a gate records.

/** The six gates of design/phone-on-orca/plan.md "The measure". `limit` is the pass line (strictly below, except criticals, which must be 0); `samples` is how many raw samples a result needs. */
export const CORE_SCREENS = [
  'chats-home',
  'chat-with-reply',
  'chat-with-approval',
  'composer-menu',
  'new-chat',
  'settings',
  'notifications',
  'pairing',
  'machine',
];
export const GATES = {
  launch: {
    title: 'warm launch to chat list painted',
    unit: 'ms',
    limit: 600,
    samples: 10,
  },
  'chat-open': {
    title: 'cached chat open to first rows',
    unit: 'ms',
    limit: 250,
    samples: 10,
  },
  hitch: {
    title: '60 s stream hitch ratio',
    unit: 'ratio',
    limit: 0.01,
    samples: 10,
  },
  'half-open': {
    title: 'half-open link detected',
    unit: 'ms',
    limit: 3000,
    samples: 10,
  },
  decision: {
    title: 'notification to decision, no app open',
    unit: 'ms',
    limit: 5000,
    samples: 10,
  },
  a11y: {
    title: 'accessibility audit, critical issues on the core screens',
    unit: 'issues',
    limit: 0,
    samples: CORE_SCREENS.length,
  },
};

/** The audit types whose findings count as critical: a person using VoiceOver, Dynamic Type or a thumb cannot use the control. */
export const CRITICAL_AUDIT_TYPES = [
  'XCUIAccessibilityAuditTypeElementDescription',
  'XCUIAccessibilityAuditTypeHitRegion',
  'XCUIAccessibilityAuditTypeTextClipped',
  'XCUIAccessibilityAuditTypeDynamicType',
  'XCUIAccessibilityAuditTypeContrast',
];

/** The middle value (the mean of the two middle ones for an even count). @param {number[]} xs */
export function median(xs) {
  if (!xs.length) throw new Error('median of no samples');
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The largest sample. @param {number[]} xs */
export function worst(xs) {
  if (!xs.length) throw new Error('worst of no samples');
  return Math.max(...xs);
}

/**
 * Apple's hitch time ratio over frame arrival times (ms): each interval longer than the expected frame time contributes its excess, and
 * the ratio is that excess over the whole span. An interval within `tolerance` x the expected time is not late (a stream's own jitter).
 * @param {number[]} times @param {{ expectedMs?: number, tolerance?: number }} [o]
 */
export function hitchRatio(times, { expectedMs = 1000 / 60, tolerance = 1.5 } = {}) {
  if (times.length < 2) throw new Error('a hitch ratio needs at least 2 frames');
  let excess = 0;
  for (let i = 1; i < times.length; i += 1) {
    const interval = times[i] - times[i - 1];
    if (interval > expectedMs * tolerance) excess += interval - expectedMs;
  }
  return excess / (times[times.length - 1] - times[0]);
}

/** "relay-token 9058 · list-shown 76990" as { 'relay-token': 9058, 'list-shown': 76990 }. @param {string} row */
export function parseTraceRow(row) {
  /** @type {Record<string, number>} */
  const steps = {};
  for (const part of row.split(' · ')) {
    const m = /^([a-z][a-z-]*) (\d+)$/.exec(part.trim());
    if (m) steps[m[1]] = Number(m[2]);
  }
  return steps;
}

/**
 * The value of one step in each trace row that has it, newest first, from the labels of Settings › About (the rows are the ones made of
 * `name ms` pairs); rows without the step are skipped.
 * @param {string[]} labels @param {string} step
 */
export function stepSamples(labels, step) {
  return labels
    .map(parseTraceRow)
    .filter((r) => step in r)
    .map((r) => r[step]);
}

/**
 * Critical findings of one accessibility audit, from WebDriverAgent's list of issues.
 * @param {{ auditType?: string }[]} issues
 */
export function criticalCount(issues) {
  return issues.filter((i) => CRITICAL_AUDIT_TYPES.includes(i.auditType ?? '')).length;
}

/**
 * What a gate records: where it ran, which build, with which flag, the raw samples and the verdict. A result with fewer samples than the gate needs fails, with the reason.
 * @param {{ gate: keyof typeof GATES, device: string, os: string, sha: string, flag: string, samples: number[], notes?: string[] }} o
 */
export function buildResult({ gate, device, os, sha, flag, samples, notes = [] }) {
  const spec = GATES[gate];
  const enough = samples.length >= spec.samples;
  const median_ = samples.length ? median(samples) : null;
  const worst_ = samples.length ? worst(samples) : null;
  // the pass line: every timing gate on its median; the audit on every screen (none may have a critical)
  const value = gate === 'a11y' ? worst_ : median_;
  const within = value !== null && (gate === 'a11y' ? value === spec.limit : value < spec.limit);
  const pass = enough && within;
  return {
    gate,
    title: spec.title,
    unit: spec.unit,
    limit: spec.limit,
    device,
    os,
    sha,
    flag,
    samples,
    median: median_,
    worst: worst_,
    pass,
    reason: pass
      ? 'ok'
      : enough
        ? `${gate === 'a11y' ? 'worst' : 'median'} ${value} is not within the limit ${spec.limit}`
        : `only ${samples.length} of ${spec.samples} samples`,
    notes,
  };
}
