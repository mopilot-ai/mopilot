// SSH commands for conditional automatic staging through the installed Host's signed updater.
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { quote } = require('./daemonInstall.cjs');
const { HOST_RUN_NODE } = require('./install.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

const DEFERRED_EXIT = 75;
const UNSUPPORTED_EXIT = 76;
const RESTART_UNCONFIRMED_EXIT = 77;
// The persisted activation counter used by activeCli in installed Host bundles.
const MAX_ACTIVATION_ATTEMPTS = 3;
const FLOOR_PREFIX = 'MOPILOT_UPDATE_FLOOR ';
const HOST_MODULES = '"$HOME/.mopilot-host/current/host/src"';
/** @typedef {{seq: number, build: string, appVersion: string}} UpdateFloor */

// The asset runs on the remote Host, where it uses that Host's installed signed updater.
const source = fs.readFileSync(path.join(__dirname, '../../host/automaticUpdateCommand.mjs.in'), 'utf8');
const options = quote(
  JSON.stringify({
    deferredExit: DEFERRED_EXIT,
    unsupportedExit: UNSUPPORTED_EXIT,
    restartUnconfirmedExit: RESTART_UNCONFIRMED_EXIT,
    maxActivationAttempts: MAX_ACTIVATION_ATTEMPTS,
    floorPrefix: FLOOR_PREFIX,
  }),
);
const READ_UPDATE_FLOOR = `${HOST_RUN_NODE} --input-type=module -e ${quote(source)} ${HOST_MODULES} ${options}`;

/** Read the result after any startup output from the remote shell. @param {string} stdout @returns {UpdateFloor | null} */
function readAutomaticFloor(stdout) {
  const line = stdout.trimEnd().split('\n').at(-1);
  if (!line?.startsWith(FLOOR_PREFIX)) return null;
  try {
    const floor = JSON.parse(line.slice(FLOOR_PREFIX.length));
    if (
      !isJsonRecord(floor) ||
      typeof floor.build !== 'string' ||
      typeof floor.appVersion !== 'string' ||
      typeof floor.seq !== 'number' ||
      !Number.isSafeInteger(floor.seq) ||
      floor.seq < 0 ||
      floor.seq >= Number.MAX_SAFE_INTEGER
    )
      return null;
    return { seq: floor.seq, build: floor.build, appVersion: floor.appVersion };
  } catch {
    return null;
  }
}

/** The archive arrives on stdin. @param {Buffer} manifest @param {UpdateFloor} floor */
function stageAutomaticCommand(manifest, floor) {
  const expected = Buffer.from(JSON.stringify(floor)).toString('base64');
  return `${READ_UPDATE_FLOOR} '${expected}' '${manifest.toString('base64')}'`;
}

module.exports = {
  READ_UPDATE_FLOOR,
  DEFERRED_EXIT,
  UNSUPPORTED_EXIT,
  RESTART_UNCONFIRMED_EXIT,
  readAutomaticFloor,
  stageAutomaticCommand,
};
