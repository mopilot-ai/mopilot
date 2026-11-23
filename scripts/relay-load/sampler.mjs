// Once a second the load harness looks at the relay from outside: its memory and CPU (`ps`), a /healthz round trip (a
// busy event loop or database makes it slow), the mailbox depth, and its own event-loop lag and socket count.
import { execFile } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { cpuSeconds, spread } from './stats.mjs';

const ps = (/** @type {number} */ pid) =>
  new Promise((resolve) =>
    execFile('ps', ['-o', 'rss=,cputime=', '-p', String(pid)], (err, out) => {
      const [rss, cpu] = String(out).trim().split(/\s+/);
      resolve(err || !cpu ? null : { rssMb: Number(rss) / 1024, cpu: cpuSeconds(cpu) });
    }),
  );

export class Sampler {
  /**
   * @param {object} o
   * @param {() => number | null} o.pid the relay process, null while it is down
   * @param {string} o.healthUrl
   * @param {() => Promise<number>} o.depth frames waiting in the mailbox
   * @param {() => number} o.sockets connected peers
   * @param {number} [o.intervalMs]
   * @param {typeof ps} [o.readProcess]
   */
  constructor({ pid, healthUrl, depth, sockets, intervalMs = 1000, readProcess = ps }) {
    this.pid = pid;
    this.healthUrl = healthUrl;
    this.depth = depth;
    this.sockets = sockets;
    this.intervalMs = intervalMs;
    this.readProcess = readProcess;
    this.rows =
      /** @type {{ rssMb?: number, cpuPct?: number, healthMs?: number, depth?: number, depthError?: string, healthFailed?: boolean, sockets: number, lagMs: number }[]} */ ([]);
    this.lag = monitorEventLoopDelay({ resolution: 10 });
    this.last = /** @type {{ cpu: number, at: number, pid: number } | null} */ (null);
    this.timer = /** @type {NodeJS.Timeout | null} */ (null);
    this.busy = false;
  }

  begin() {
    this.lag.enable();
    // a slow relay makes a sample slow: the next tick waits for it rather than overlapping
    this.timer = setInterval(() => this.busy || this.sample(), this.intervalMs).unref();
  }

  async sample() {
    this.busy = true;
    try {
      await this.#take();
    } finally {
      this.busy = false;
    }
  }

  async #take() {
    const row = /** @type {(typeof this.rows)[number]} */ ({ sockets: this.sockets(), lagMs: this.lag.percentile(99) / 1e6 });
    this.lag.reset();
    const pid = this.pid();
    const proc = pid ? await this.readProcess(pid) : null;
    if (proc) {
      row.rssMb = proc.rssMb;
      const at = Date.now();
      // a restarted relay is another process: its cpu time starts over, so there is nothing to subtract
      if (this.last && this.last.pid === pid && at > this.last.at)
        row.cpuPct = ((proc.cpu - this.last.cpu) / ((at - this.last.at) / 1000)) * 100;
      this.last = { cpu: proc.cpu, at, pid: /** @type {number} */ (pid) };
    } else this.last = null;
    const started = performance.now();
    try {
      await fetch(this.healthUrl, { signal: AbortSignal.timeout(5000) });
      row.healthMs = performance.now() - started;
    } catch {
      // down or too slow: counted in the summary, not averaged into the round trips
      row.healthFailed = true;
    }
    try {
      row.depth = await this.depth();
    } catch (e) {
      row.depthError = String(/** @type {Error} */ (e).message);
    }
    this.rows.push(row);
  }

  end() {
    if (this.timer) clearInterval(this.timer);
    this.lag.disable();
  }

  /** The relay's memory at the start and at the end of the run (the mean of the first and of the last tenth of the samples): a soak that grows is a leak. */
  trend() {
    const rss = this.rows.map((r) => r.rssMb).filter((v) => v !== undefined);
    const n = Math.floor(rss.length / 10);
    if (n < 3) return null;
    const mean = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return { startMb: mean(rss.slice(0, n)), endMb: mean(rss.slice(-n)) };
  }

  summary() {
    const col = (/** @type {'rssMb' | 'cpuPct' | 'healthMs' | 'depth' | 'lagMs'} */ k) =>
      this.rows.map((r) => r[k]).filter((v) => v !== undefined);
    return {
      rssMb: spread(/** @type {number[]} */ (col('rssMb'))),
      cpuPct: spread(/** @type {number[]} */ (col('cpuPct'))),
      healthMs: spread(/** @type {number[]} */ (col('healthMs'))),
      mailboxDepth: spread(/** @type {number[]} */ (col('depth'))),
      harnessLagMs: spread(/** @type {number[]} */ (col('lagMs'))),
      depthErrors: this.rows.filter((r) => r.depthError).length,
      healthFailures: this.rows.filter((r) => r.healthFailed).length,
      rssTrend: this.trend(),
      seconds: this.rows.length,
    };
  }
}
