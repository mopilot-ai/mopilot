// DEV ONLY command line of the Mobile Remote dev host: reads the options, starts the host, prints the pairing QR and the phone build's address, and answers a few one-letter commands until it is stopped.
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import QRCode from 'qrcode';
import { defaultScratch } from './scratch.mjs';
import { lanAddress } from './lan.mjs';
import { startHost } from './host.mjs';
import { realHostFor } from './realHostKit.mjs';

/** How often --renew makes a fresh code: a code lives two minutes, so one read from the file always has at least a minute left. */
const RENEW_MS = 60_000;

export const USAGE = `Usage: node scripts/mobile-dev-host.mjs [options]

  --port <n>      port for the relay and the sign-in stand-in (default 8787)
  --dir <path>    scratch folder; a restart keeps the pairing (default ~/.mopilot-mobile-dev-host)
  --host <addr>   address the phone should use (default: this Mac's LAN address)
  --loopback      listen on 127.0.0.1 only, for a simulator on this Mac
  --ask           ask here before accepting a pairing, after comparing the safety number
  --renew         make a fresh pairing code every minute while nobody is mid-pairing (a code lives two minutes)
  --no-mirrors    leave the terminal and screen mirrors off for the phone
  --fake-hosts    the account has Host: two made-up machines for New chat on a machine, chips and Switch host ("run hosts" flips one)
  --real-host <vm> install a real Host in the Tart VM (scripts/host-accept: hold its lock) with the fake ACP agent and let the phone enroll with it
                  through the Mac's own enrollment code ("run direct on" is the Mac's switch); implies --fake-hosts
  --vm-gateway <ip> this Mac as that VM sees it (default 192.168.64.1, Tart's)
  --keep-host     leave that Host installed when the dev host stops
  --uninvited     the account has no Mobile Remote invite, for the phone's screen that says so
  --qr-account <user-id>[:<email>]  the pairing QR names this account (the phone's dev account is dev-user:dev@mopilot.local): another id shows the phone's "a computer on another account" card at the scan, dev-user the match
  --help

The current code is always in <dir>/pairing-code.txt.
Commands while running: r new pairing QR, s status, scenarios (list the bench scenarios),
run <scenario> [args] (start one), q quit.`;

/**
 * @param {string[]} argv
 * @param {{ stdin?: NodeJS.ReadableStream, out?: (text: string) => void, lan?: () => string | null, start?: typeof startHost, makeRealHost?: typeof realHostFor, writeCode?: (file: string, text: string) => Promise<unknown>, every?: (fn: () => void, ms: number) => { unref?: () => void } & object, stopEvery?: (timer: any) => void }} [io]
 * @returns {Promise<{ stop: () => Promise<void>, done: Promise<void> } | null>} null when there was nothing to run
 */
export async function main(
  argv,
  {
    stdin = /** @type {NodeJS.ReadableStream} */ (process.stdin),
    out = console.log,
    lan = lanAddress,
    start = startHost,
    makeRealHost = realHostFor,
    writeCode = (file, text) => writeFile(file, text, { mode: 0o600 }),
    every = setInterval,
    stopEvery = clearInterval,
  } = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: '8787' },
      dir: { type: 'string', default: defaultScratch() },
      host: { type: 'string' },
      loopback: { type: 'boolean', default: false },
      ask: { type: 'boolean', default: false },
      renew: { type: 'boolean', default: false },
      'no-mirrors': { type: 'boolean', default: false },
      'fake-hosts': { type: 'boolean', default: false },
      'real-host': { type: 'string' },
      'keep-host': { type: 'boolean', default: false },
      'vm-gateway': { type: 'string' },
      uninvited: { type: 'boolean', default: false },
      'qr-account': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    out(USAGE);
    return null;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0-65535, got ${values.port}`);
  const advertise = values.host ?? (values.loopback ? '127.0.0.1' : lan());
  if (!advertise) throw new Error('No LAN address found; join the phone and this Mac to one network or pass --host <address>');

  // opened once the host is up, so a failed start leaves nothing reading the terminal
  /** @type {import('node:readline').Interface | null} */
  let rl = null;
  const confirm = values.ask
    ? async (/** @type {{ device: { name: string }, safetyNumber: string, signal: AbortSignal }} */ { device, safetyNumber, signal }) => {
        if (signal.aborted) return null;
        out(`Pairing "${device.name}": the phone shows safety number ${safetyNumber}. Type y to allow, anything else to deny.`);
        const answer = await new Promise((resolve) => {
          /** @type {import('node:readline').Interface} */ (rl).question('> ', { signal }, resolve);
          signal.addEventListener('abort', () => resolve(null));
        });
        return answer === null ? null : /^y/i.test(String(answer).trim()) ? 'allow' : 'deny';
      }
    : undefined;
  // `<user-id>[:<email>]`: the first colon ends the id, so an email keeps its own characters
  const [qrId, ...qrEmail] = (values['qr-account'] ?? '').split(':');
  if (values['qr-account'] !== undefined && !qrId) throw new Error('--qr-account needs a user id: <user-id>[:<email>]');
  const qrAccount = qrId ? { id: qrId, ...(qrEmail.length && { email: qrEmail.join(':') }) } : undefined;
  /** The real Host, set up before the host starts so a phone never sees a machine that is half there. */
  const realHost = values['real-host']
    ? await makeRealHost({
        vm: values['real-host'],
        dir: values.dir,
        log: out,
        relayPort: port,
        ...(values['vm-gateway'] && { gateway: values['vm-gateway'] }),
      })
    : null;
  /** @type {Awaited<ReturnType<typeof start>>} */
  let host;
  try {
    host = await start({
      dir: values.dir,
      advertise,
      port,
      bind: values.loopback ? '127.0.0.1' : '0.0.0.0',
      out,
      confirm,
      mirrors: !values['no-mirrors'],
      fakeHosts: values['fake-hosts'] || realHost !== null,
      realHost,
      uninvited: values.uninvited,
      ...(qrAccount && { qrAccount }),
    });
  } catch (error) {
    // a failed start leaves no Host installed behind it
    await realHost?.stop({ keep: values['keep-host'] });
    throw error;
  }

  /** A new pairing code, also written to <dir>/pairing-code.txt for whoever pastes it. */
  const newCode = async () => {
    const made = await host.pair();
    await writeCode(path.join(values.dir, 'pairing-code.txt'), made.qr);
    return made;
  };
  const showQr = async () => {
    const { qr, expiresAt } = await newCode();
    out(await QRCode.toString(qr, { type: 'terminal', small: true }));
    out(`Pairing code (paste it in the app instead of scanning; expires ${new Date(expiresAt).toLocaleTimeString()}):\n${qr}`);
  };
  out(
    [
      'Mobile Remote dev host — DEV ONLY: plain ws/http on your LAN, signs every phone in, no TLS. Use a network you trust.',
      `  relay    ${host.relayUrl}`,
      `  account  ${host.accountUrl}`,
      `  build the phone with MOPILOT_DEV_HOST=${host.accountUrl}  (and start Metro with it too: MOPILOT_DEV_HOST=${host.accountUrl} npx expo start --dev-client --lan)`,
      `  scratch  ${values.dir}${host.shellsReal ? '' : '  (node-pty unavailable: terminals use plain pipes)'}`,
      `  paired   ${
        host.devices().length
          ? host
              .devices()
              .map((d) => d.name)
              .join(', ')
          : 'none yet'
      }`,
      'Commands: r new pairing QR, s status, scenarios, run <scenario> [args], q quit.',
    ].join('\n'),
  );
  try {
    await showQr();
  } catch (error) {
    await host.stop();
    await realHost?.stop({ keep: values['keep-host'] });
    throw error;
  }
  const input = createInterface({ input: stdin });
  rl = input;
  // a pairing someone is confirming is not replaced (the host refuses): the renewal says so and is tried again next minute
  const renewing = values.renew
    ? every(() => void newCode().catch((e) => out(`pairing code not renewed (${e.message}); trying again in a minute`)), RENEW_MS)
    : null;
  renewing?.unref?.();

  // assigned by the promise executor, which runs at once
  let finish = /** @type {(value?: unknown) => void} */ (/** @type {unknown} */ (undefined));
  const done = new Promise((resolve) => (finish = resolve));
  let begun = false;
  const stop = async () => {
    // closing the input fires its own close event, which asks to stop again
    if (begun) return done;
    begun = true;
    if (renewing) stopEvery(renewing);
    input.close();
    await host.stop();
    await realHost?.stop({ keep: values['keep-host'] });
    out('stopped');
    finish(undefined);
  };
  input.on('line', (text) => {
    const [word = '', ...args] = text.trim().split(/\s+/);
    const command = word.toLowerCase();
    if (command === 'scenarios') for (const { usage, about } of host.scenarios.list()) out(`  run ${usage.padEnd(32)} ${about}`);
    else if (command === 'run')
      void (async () => {
        try {
          out(await host.scenarios.run((args[0] ?? '').toLowerCase(), args.slice(1)));
        } catch (error) {
          out(/** @type {Error} */ (error).message);
        }
      })();
    else if (command === 'r') showQr().catch((e) => out(`could not make a pairing code: ${e.message}`));
    else if (command === 's')
      out(
        `paired: ${
          host
            .devices()
            .map((d) => `${d.name} (${d.id})`)
            .join(', ') || 'none'
        }`,
      );
    else if (command === 'q') void stop();
  });
  // Ctrl-D at a terminal ends the host; an input that is not a terminal (nohup, a launcher) closing does not
  input.on('close', () => /** @type {NodeJS.ReadStream} */ (stdin).isTTY && void stop());
  return { stop, done };
}

/**
 * The process entry's body: runs until a signal or `q`, and reports a failure as one line and exit code 1.
 * @param {string[]} argv
 * @param {Parameters<typeof main>[1] & { proc?: Pick<NodeJS.Process, 'once' | 'exitCode'>, err?: (text: string) => void }} [io]
 */
export async function run(argv, { proc = process, err = console.error, ...io } = {}) {
  try {
    const running = await main(argv, io);
    if (!running) return;
    for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) proc.once(signal, () => void running.stop());
    await running.done;
  } catch (error) {
    err(`mobile-dev-host: ${error instanceof Error ? error.message : error}`);
    proc.exitCode = 1;
  }
}
