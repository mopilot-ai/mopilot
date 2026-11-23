// DEV ONLY: command line of the phone gates: reads the options, wires WebDriverAgent, the shell and the operator's keyboard, runs one gate, prints its samples and verdict, and writes the result under design/phone-on-orca/measure/.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { Wda } from '../mobile-ios-journey/wda.mjs';
import { CRITICAL_AUDIT_TYPES, GATES, buildResult } from './stats.mjs';
import { checkBundleId, mjpegFrameTimes, runA11y, runChatOpen, runDecision, runHalfOpen, runHitch, runLaunch } from './gates.mjs';

export const USAGE = `Usage: node scripts/phone-gates/cli.mjs <gate> --bundle-id <id> --device <name> --flag <value> [options]

gates: ${Object.keys(GATES).join(', ')}

A gate runs on a SEPARATE build (for example ai.mopilot.phone.dev) against a dev host, never on the owner's app (ai.mopilot.phone, and ai.mopilot.remote from before, are refused).
Each result records the device, the OS, the build SHA, the flag value and the raw samples (10; the audit has one per core screen), and fails with fewer.

  --bundle-id <id>      the build under test (required)
  --device <name>       for example "iPhone 13 Pro Max" (required)
  --flag <value>        the new-UI flag's value for this build, or "none" (required)
  --out <dir>           where results go (default design/phone-on-orca/measure)
  --sha <sha>           the build's commit (default: HEAD of this checkout)
  --count <n>           samples for the timing gates (default 10)
  --chat <title>        chat-open: the title of the chat to open
  --host-pid <pid>      half-open: the dev host's pid (it is frozen with SIGSTOP and thawed again)
  --stream-cmd <shell>  hitch: starts the dev host's synthetic 60 s stream
  --frames <file,...>   hitch: use frame times (a JSON array of ms) from an Animation Hitches trace instead of capturing; one file per sample
  --seconds <n>         hitch: capture length (default 60)
Environment: MOPILOT_WDA_BASE (WebDriverAgent, default its tunnel address on :8100 via MOPILOT_IOS_UDID), MOPILOT_IOS_UDID, MOPILOT_MJPEG_URL (default WebDriverAgent's host on :9100).
Exit status: 0 the gate passed, 1 it failed, 2 a wrong call or the gate could not run.`;

const exec = promisify(execFile);

/** A question on a terminal: the prompt, then a line. @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} output */
export const makeAsk = (input, output) => async (/** @type {string} */ prompt) => {
  const rl = readline.createInterface({ input, output });
  await rl.question(`${prompt} `);
  rl.close();
};

/** What the command line really uses; the tests replace any of it. */
export const realDeps = {
  say: console.log,
  makeWda: (/** @type {{ base: string, bundleId: string }} */ o) => new Wda(o),
  shell: (/** @type {string} */ command) => exec('/bin/sh', ['-c', command]),
  exec: (/** @type {string} */ file, /** @type {string[]} */ args) => exec(file, args),
  kill: (/** @type {number} */ pid, /** @type {string} */ signal) => void process.kill(pid, /** @type {NodeJS.Signals} */ (signal)),
  ask: makeAsk(process.stdin, process.stdout),
  now: () => performance.now(),
  mjpeg: async (/** @type {string} */ url) => /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ ((await fetch(url)).body)),
  readText: (/** @type {string} */ file) => fs.readFile(file, 'utf8'),
  writeText: async (/** @type {string} */ file, /** @type {string} */ text) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  },
  sha: () =>
    execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    }).trim(),
};

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {Partial<{ say: (line: string) => void, makeWda: (o: { base: string, bundleId: string }) => Wda, shell: (command: string) => Promise<unknown>,
 *   exec: (file: string, args: string[]) => Promise<unknown>, kill: (pid: number, signal: string) => void, ask: (prompt: string) => Promise<void>, now: () => number,
 *   mjpeg: (url: string) => Promise<AsyncIterable<Uint8Array>>, readText: (file: string) => Promise<string>, writeText: (file: string, text: string) => Promise<void>,
 *   sha: () => string }>} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, env = process.env, deps = {}) {
  const { say, makeWda, shell, exec: run, kill, ask, now, mjpeg, readText, writeText, sha } = { ...realDeps, ...deps };
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'bundle-id': { type: 'string' },
        device: { type: 'string' },
        flag: { type: 'string' },
        out: { type: 'string' },
        sha: { type: 'string' },
        count: { type: 'string' },
        chat: { type: 'string' },
        'host-pid': { type: 'string' },
        'stream-cmd': { type: 'string' },
        frames: { type: 'string' },
        seconds: { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (error) {
    say(`${/** @type {Error} */ (error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    say(USAGE);
    return 0;
  }
  const [gate] = positionals;
  if (!gate || !Object.hasOwn(GATES, gate)) {
    say(`Name one gate: ${Object.keys(GATES).join(', ')}\n${USAGE}`);
    return 2;
  }
  try {
    const bundleId = checkBundleId(values['bundle-id']);
    if (!values.device || !values.flag) throw new Error('give --device and --flag (use --flag none for a build without the flag)');
    const udid = env.MOPILOT_IOS_UDID;
    const base = env.MOPILOT_WDA_BASE ?? (udid ? await tunnelBase(run, udid) : undefined);
    const count = values.count ? Number(values.count) : 10;
    if (!Number.isInteger(count) || count < 1) throw new Error('--count is a whole number of at least 1');
    /** @type {any} */
    const wda = ['launch', 'chat-open', 'half-open', 'a11y'].includes(gate) ? await openWda(makeWda, base, bundleId) : null;
    const spec = /** @type {keyof typeof GATES} */ (gate);
    const os = wda ? await osOf(wda) : 'not read (no WebDriverAgent used)';
    const ran = await runGate(spec, {
      wda,
      base,
      values,
      count,
      env,
      bundleId,
      shell,
      kill,
      ask,
      now,
      mjpeg,
      readText,
    });
    const result = buildResult({
      gate: spec,
      device: values.device,
      os,
      sha: values.sha ?? sha(),
      flag: values.flag,
      ...ran,
    });
    const file = path.join(values.out ?? path.join('design', 'phone-on-orca', 'measure'), `${spec}-${bundleId}-${result.sha}.json`);
    await writeText(file, `${JSON.stringify(result, null, 2)}\n`);
    say(`${result.title}: samples ${result.samples.join(', ')}`);
    say(
      `median ${result.median}, worst ${result.worst} ${result.unit}, limit ${result.limit}: ${result.pass ? 'PASS' : `FAIL (${result.reason})`}`,
    );
    say(`written ${file}`);
    return result.pass ? 0 : 1;
  } catch (error) {
    say(/** @type {Error} */ (error).message);
    return 2;
  }
}

/** The device's CoreDevice tunnel address, where WebDriverAgent listens. */
async function tunnelBase(/** @type {(file: string, args: string[]) => Promise<any>} */ run, /** @type {string} */ udid) {
  const { stdout } = await run('xcrun', ['devicectl', 'device', 'info', 'details', '--device', udid]);
  const ip = /Tunnel IP Address: *(\S+)/.exec(String(stdout))?.[1];
  if (!ip) throw new Error(`no tunnel address for ${udid}; is the phone connected and unlocked?`);
  return `http://[${ip}]:8100`;
}

async function openWda(/** @type {any} */ makeWda, /** @type {string | undefined} */ base, /** @type {string} */ bundleId) {
  if (!base) throw new Error('set MOPILOT_WDA_BASE or MOPILOT_IOS_UDID (scripts/mobile-ios-wda.sh run <udid> starts WebDriverAgent)');
  return makeWda({ base, bundleId }).open();
}

async function osOf(/** @type {any} */ wda) {
  const status = (await wda.call('GET', '/status')).value?.os;
  return `${status?.name ?? 'iOS'} ${status?.version ?? 'unknown'}`;
}

/** Runs one gate with the options it takes. @param {keyof typeof GATES} gate @param {any} c */
async function runGate(gate, c) {
  const need = (/** @type {string | undefined} */ value, /** @type {string} */ flag) => {
    if (!value) throw new Error(`${gate} needs ${flag}`);
    return value;
  };
  if (gate === 'launch') {
    return runLaunch({
      wda: c.wda,
      count: c.count,
      terminate: async () =>
        void (await c.wda.call('POST', c.wda.s('/wda/apps/terminate'), {
          bundleId: c.bundleId,
        })),
    });
  }
  if (gate === 'chat-open')
    return runChatOpen({
      wda: c.wda,
      chat: need(c.values.chat, '--chat'),
      count: c.count,
    });
  if (gate === 'half-open') {
    const pid = Number(need(c.values['host-pid'], '--host-pid'));
    return runHalfOpen({
      wda: c.wda,
      now: c.now,
      count: c.count,
      freeze: () => c.kill(pid, 'SIGSTOP'),
      thaw: () => c.kill(pid, 'SIGCONT'),
    });
  }
  if (gate === 'hitch') {
    const files = c.values.frames ? c.values.frames.split(',') : null;
    let next = 0;
    if (files) {
      return runHitch({
        startStream: async () => undefined,
        count: files.length,
        capture: async () => JSON.parse(await c.readText(files[next++])),
      });
    }
    const stream = need(c.values['stream-cmd'], '--stream-cmd or --frames');
    const url = c.env.MOPILOT_MJPEG_URL ?? `http://${new URL(need(c.base, 'MOPILOT_WDA_BASE or MOPILOT_IOS_UDID')).hostname}:9100`;
    const seconds = Number(c.values.seconds ?? 60);
    return runHitch({
      count: c.count,
      startStream: async () => void (await c.shell(stream)),
      capture: async () => mjpegFrameTimes(firstSeconds(await c.mjpeg(url), seconds, c.now), c.now),
    });
  }
  if (gate === 'decision') return runDecision({ ask: c.ask, now: c.now, count: c.count });
  return runA11y({
    ask: c.ask,
    audit: async () =>
      (
        await c.wda.call('POST', c.wda.s('/wda/performAccessibilityAudit'), {
          auditTypes: CRITICAL_AUDIT_TYPES,
        })
      ).value,
  });
}

/** A stream cut off after `seconds`. @param {AsyncIterable<Uint8Array>} source @param {number} seconds @param {() => number} now */
async function* firstSeconds(source, seconds, now) {
  const end = now() + seconds * 1000;
  for await (const chunk of source) {
    yield chunk;
    if (now() >= end) return;
  }
}
