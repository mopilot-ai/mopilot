// Command line of the relay load harness: reads the options, runs one load run and prints (and optionally saves) its report.
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULTS, runLoad } from './run.mjs';
import { formatReport } from './stats.mjs';

export const USAGE = `Usage: node scripts/relay-load.mjs [options]

  --pairs <n>            paired Mac+phone count (default ${DEFAULTS.pairs}; sockets = 2 x pairs)
  --seconds <n>          how long traffic runs (default ${DEFAULTS.seconds})
  --mac-rate <f>         frames per second each Mac sends (default ${DEFAULTS.macRate})
  --phone-rate <f>       frames per second each phone sends (default ${DEFAULTS.phoneRate})
  --burst <p:f:bytes>    p Macs send f frames of that size at once, one third in (default 50:200:4096; "off")
  --restarts <n>         relay process restarts during the run (default ${DEFAULTS.restarts}; SIGKILL unless --signal)
  --signal <name>        how a restart stops the relay (default SIGKILL; SIGTERM tries the graceful path)
  --restart-down <ms>    how long the relay stays down (default ${DEFAULTS.restartDownMs})
  --kill-rate <n>        sockets cut per second (default ${DEFAULTS.killRate})
  --reset-rate <n>       rounds per second of TCP resets on extra sockets, one per phase of a connection (half-sent upgrade, reset during the
                         token check, before hello, mid-frame, during close, with a receipt in flight); the relay process must survive (default ${DEFAULTS.resetRate})
  --database <url>       a Postgres URL: the relay then runs as a child process; without it, in this process on PGlite.
                         The relay's tables in it are emptied first, so it must be a scratch database on this machine
  --allow-remote-database  allow that scratch database to be on another host
  --env <KEY=VALUE>      an environment variable for the relay (repeatable)
  --drain <seconds>      how long to wait for the mailbox to empty at the end (default ${DEFAULTS.drainSeconds})
  --json <file>          also write the report as JSON
  --help

Exit status 1 when no frame was sent, or any accepted frame was lost, duplicated, reordered or corrupt, or the mailbox did not drain.`;

/** @param {string[]} argv */
export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pairs: { type: 'string' },
      seconds: { type: 'string' },
      'mac-rate': { type: 'string' },
      'phone-rate': { type: 'string' },
      burst: { type: 'string' },
      restarts: { type: 'string' },
      signal: { type: 'string' },
      'restart-down': { type: 'string' },
      'kill-rate': { type: 'string' },
      'reset-rate': { type: 'string' },
      database: { type: 'string' },
      'allow-remote-database': { type: 'boolean' },
      env: { type: 'string', multiple: true },
      drain: { type: 'string' },
      json: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const num = (/** @type {string} */ name, /** @type {string | undefined} */ v, /** @type {number} */ d, min = 0, int = false) => {
    if (v === undefined) return d;
    const n = Number(v);
    if (v === '' || !Number.isFinite(n) || n < min || (int && !Number.isInteger(n)))
      throw new Error(`--${name} must be ${int ? 'a whole number' : 'a number'} of at least ${min}, got ${v}`);
    return n;
  };
  let burst = DEFAULTS.burst;
  if (values.burst === 'off') burst = null;
  else if (values.burst) {
    const [pairs, frames, size, ...extra] = values.burst.split(':');
    if (size === undefined || extra.length) throw new Error(`--burst must be pairs:frames:bytes (or off), got ${values.burst}`);
    burst = {
      at: 0.3,
      pairs: num('burst', pairs, 0, 1, true),
      frames: num('burst', frames, 0, 1, true),
      size: num('burst', size, 0, 1, true),
    };
  }
  const relayEnv = Object.fromEntries(
    (values.env ?? []).map((kv) => {
      const at = kv.indexOf('=');
      if (at < 1) throw new Error(`--env needs KEY=VALUE, got ${kv}`);
      return [kv.slice(0, at), kv.slice(at + 1)];
    }),
  );
  return {
    help: !!values.help,
    json: values.json,
    options: {
      pairs: num('pairs', values.pairs, DEFAULTS.pairs, 1, true),
      seconds: num('seconds', values.seconds, DEFAULTS.seconds, 1),
      macRate: num('mac-rate', values['mac-rate'], DEFAULTS.macRate),
      phoneRate: num('phone-rate', values['phone-rate'], DEFAULTS.phoneRate),
      burst,
      restarts: num('restarts', values.restarts, DEFAULTS.restarts, 0, true),
      restartSignal: /** @type {NodeJS.Signals} */ (values.signal ?? DEFAULTS.restartSignal),
      restartDownMs: num('restart-down', values['restart-down'], DEFAULTS.restartDownMs),
      killRate: num('kill-rate', values['kill-rate'], DEFAULTS.killRate),
      resetRate: num('reset-rate', values['reset-rate'], DEFAULTS.resetRate),
      database: values.database ?? '',
      allowRemoteDatabase: !!values['allow-remote-database'],
      drainSeconds: num('drain', values.drain, DEFAULTS.drainSeconds, 1),
      relayEnv,
    },
  };
}

/** The exit status a finished report earns. */
export const verdict = (/** @type {any} */ r) =>
  !r.ledger.created ||
  r.mailboxKnown === false ||
  r.ledger.lost ||
  r.ledger.undelivered ||
  r.ledger.duplicated ||
  r.ledger.reordered ||
  r.ledger.corrupt ||
  r.ledger.phantom ||
  r.chaos.relayCrashes ||
  !r.drained ||
  r.mailboxLeft
    ? 1
    : 0;

/** @param {string[]} argv @param {{ out?: (text: string) => void, run?: typeof runLoad }} [deps] */
export async function run(argv, { out = console.log, run: load = runLoad } = {}) {
  const { help, json, options } = parseOptions(argv);
  if (help) return void out(USAGE);
  const report = await load(options, { log: (line) => out(`[relay-load] ${line}`) });
  out(formatReport(report));
  if (json) await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = verdict(report);
}
