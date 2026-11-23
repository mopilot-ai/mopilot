// DEV ONLY: command line of the iOS journey: reads the options and the environment the shell wrapper sets, wires WebDriverAgent and the dev host, and runs the steps.
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { Wda } from './wda.mjs';
import { JourneyHost } from './host.mjs';
import { runJourney } from './run.mjs';
import { steps } from './steps.mjs';

export const USAGE = `Usage: node scripts/mobile-ios-journey/cli.mjs [--out <dir>] [--only <step,step>] [--list]

Runs the Mobile Remote journey on a device through WebDriverAgent (our app only) against the dev host. Normally started by
scripts/mobile-ios-journey.sh, which sets:
  MOPILOT_WDA_BASE          WebDriverAgent's address
  MOPILOT_JOURNEY_FIFO      the dev host's input FIFO         MOPILOT_JOURNEY_LOG    its log
  MOPILOT_JOURNEY_CODE_FILE its pairing-code file (default ~/.mopilot-mobile-dev-host/pairing-code.txt)
  MOPILOT_JOURNEY_LAUNCH    shell command that relaunches the app on the device
Exit status: 0 when every step passed, 1 naming the first step that failed, 2 for a wrong call or when the journey could not run (WebDriverAgent unreachable, the dev host not reading its input).`;

const exec = promisify(execFile);

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {{ say?: (line: string) => void, makeWda?: (o: { base: string, bundleId: string }) => Wda, makeHost?: (o: { fifo: string, log: string, codeFile: string }) => JourneyHost,
 *   run?: (shell: string) => Promise<unknown>, now?: () => Date }} [deps]
 * @returns {Promise<number>} the exit status
 */
export async function main(
  argv,
  env = process.env,
  {
    say = console.log,
    makeWda = (o) => new Wda(o),
    makeHost = (o) => new JourneyHost(o),
    run = (shell) => exec('/bin/sh', ['-c', shell]),
    now = () => new Date(),
  } = {},
) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { out: { type: 'string' }, only: { type: 'string' }, list: { type: 'boolean' }, help: { type: 'boolean' } },
    }));
  } catch (error) {
    say(`${/** @type {Error} */ (error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    say(USAGE);
    return 0;
  }
  if (values.list) {
    for (const step of steps) say(step.name);
    return 0;
  }
  const { MOPILOT_WDA_BASE: base, MOPILOT_JOURNEY_FIFO: fifo, MOPILOT_JOURNEY_LOG: log, MOPILOT_JOURNEY_LAUNCH: launch } = env;
  if (!base || !fifo || !log || !launch) {
    say(
      `Set MOPILOT_WDA_BASE, MOPILOT_JOURNEY_FIFO, MOPILOT_JOURNEY_LOG and MOPILOT_JOURNEY_LAUNCH (scripts/mobile-ios-journey.sh does).\n${USAGE}`,
    );
    return 2;
  }
  const wda = makeWda({ base, bundleId: 'ai.mopilot.phone' });
  const host = makeHost({
    fifo,
    log,
    codeFile: env.MOPILOT_JOURNEY_CODE_FILE ?? path.join(os.homedir(), '.mopilot-mobile-dev-host', 'pairing-code.txt'),
  });
  const out = values.out ?? path.join(os.tmpdir(), 'mopilot-journey', `journey-${now().toISOString().replace(/[:.]/g, '-')}`);
  // a relaunched app is a new process: the old WebDriverAgent session no longer reaches it
  const relaunch = async () => {
    await run(launch);
    await wda.sleep(15_000);
    await wda.open();
    await wda.acceptAlert();
  };
  try {
    await wda.open();
    const result = await runJourney({ wda, host, relaunch, out, say, only: values.only?.split(',').filter(Boolean) });
    return result.ok ? 0 : 1;
  } catch (error) {
    say(/** @type {Error} */ (error).message);
    return 2;
  }
}
