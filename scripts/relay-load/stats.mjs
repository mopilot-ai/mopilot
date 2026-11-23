// Latency histograms, process samples and the end-of-run summary of the relay load harness.
import { createHistogram } from 'node:perf_hooks';

export class Latency {
  constructor() {
    this.histogram = createHistogram();
    this.count = 0;
  }

  record(/** @type {number} */ ms) {
    this.histogram.record(Math.max(1, Math.round(ms * 1000)));
    this.count++;
  }

  summary() {
    if (!this.count) return { count: 0 };
    const at = (/** @type {number} */ q) => Math.round(this.histogram.percentile(q)) / 1000;
    return { count: this.count, p50: at(50), p95: at(95), p99: at(99), max: this.histogram.max / 1000 };
  }
}

/** Min, mean and max of a list of numbers (null when empty). */
export function spread(/** @type {number[]} */ xs) {
  if (!xs.length) return null;
  let sum = 0;
  let max = -Infinity;
  for (const x of xs) {
    sum += x;
    max = Math.max(max, x);
  }
  return { mean: sum / xs.length, max };
}

/** `ps -o cputime` text ("0:01.50", "1:02:03.25") as seconds. */
export function cpuSeconds(/** @type {string} */ text) {
  return text
    .trim()
    .split(':')
    .reduce((total, part) => total * 60 + Number(part), 0);
}

const round = (/** @type {number} */ n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** One-screen text of a finished run's report. */
export function formatReport(/** @type {any} */ r) {
  const lat = (/** @type {any} */ l) =>
    l.count ? `p50 ${l.p50} ms  p95 ${l.p95} ms  p99 ${l.p99} ms  max ${l.max} ms  (${l.count} frames)` : 'no samples';
  const lines = [
    `relay load: ${r.config.pairs} pairs, ${r.config.sockets} sockets, ${r.config.seconds}s, ${r.mode}`,
    `frames   created ${r.ledger.created}  accepted ${r.ledger.accepted}  received ${r.ledger.received}  resends ${r.client.resends}`,
    `verdict  LOST ${r.ledger.lost}  undelivered at the end ${r.ledger.undelivered}  duplicated ${r.ledger.duplicated}  reordered ${r.ledger.reordered}  corrupt ${r.ledger.corrupt}  phantom ${r.ledger.phantom}  (redelivered after reconnect: ${r.ledger.redelivered})`,
    `latency  steady   ${lat(r.latency.steady)}`,
    `         all      ${lat(r.latency.all)}`,
    `senders  frames never accepted by the relay (still queued at the sender): ${r.client.unaccepted}`,
    `chaos    sockets killed ${r.chaos.socketsKilled}  relay restarts ${r.chaos.relayRestarts}  reconnects ${r.client.reconnects}  client closes ${JSON.stringify(r.client.closes)}  relay errors ${JSON.stringify(r.client.errors)}`,
  ];
  if (r.chaos.resets && Object.values(r.chaos.resets).some(Boolean))
    lines.push(
      `resets   ${JSON.stringify(r.chaos.resets)}  not made ${r.chaos.resetsSkipped}  relay process ended on its own ${r.chaos.relayCrashes} time(s)`,
    );
  if (r.mailboxKnown === false) lines.push('WARNING  the mailbox could not be read at the end: every unreceived frame is counted as lost');
  if (r.relayEvents && Object.keys(r.relayEvents).length) lines.push(`events   other relay log events: ${JSON.stringify(r.relayEvents)}`);
  if (r.relayErrorSamples?.length) lines.push(`errors   first relay errors: ${JSON.stringify(r.relayErrorSamples)}`);
  if (r.relayCloseCodes) lines.push(`closes   by code seen in the relay log: ${JSON.stringify(r.relayCloseCodes)}`);
  const s = r.samples;
  if (s.rssMb)
    lines.push(
      `relay    rss mean ${round(s.rssMb.mean)} MB  max ${round(s.rssMb.max)} MB  cpu mean ${round(s.cpuPct?.mean ?? 0)}%  max ${round(s.cpuPct?.max ?? 0)}%${s.rssTrend ? `  (first tenth ${round(s.rssTrend.startMb)} MB, last tenth ${round(s.rssTrend.endMb)} MB)` : ''}`,
    );
  if (s.mailboxDepth)
    lines.push(`mailbox  depth mean ${round(s.mailboxDepth.mean)}  max ${s.mailboxDepth.max}  left at end ${r.mailboxLeft}`);
  if (s.healthMs || s.healthFailures)
    lines.push(
      `loop     /healthz round trip mean ${round(s.healthMs?.mean ?? 0)} ms  max ${round(s.healthMs?.max ?? 0)} ms  failed or timed out ${s.healthFailures ?? 0}   harness loop lag p99 max ${round(s.harnessLagMs?.max ?? 0)} ms`,
    );
  return lines.join('\n');
}
