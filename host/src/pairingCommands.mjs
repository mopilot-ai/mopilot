// The Host's pairing commands run from a terminal on this machine: `mopilot-host pair` (a code for a phone) and `mopilot-host reset-approval --yes` (R2b of #5576, slice 4): the way out when the approval key is lost, replaced or must be made again. It removes the approval key and every controller (the records, and the relay links they brought), on this machine only, from a terminal; a controller is never believed without the proof its key signed, so the controllers go with the key and each Mac is paired by code again. A Host that is serving keeps the links it has open until it restarts (its trust checks read the files at once).
import fs from 'node:fs';
import path from 'node:path';
import { createPairing } from './pairing.mjs';
import { retireEnrollments } from './relayLink.mjs';
import { readControllers } from './trustState.mjs';

/** `pair`: a pairing code for a phone, shown once. @param {{ configDir: string, out: (line: string) => void }} o */
export function pairCommand({ configDir, out }) {
  out(`Pairing code: ${createPairing({ configDir }).issueCode()}`);
  return 0;
}

/**
 * @param {{ argv: string[], configDir: string, out: (line: string) => void, err: (line: string) => void }} o
 * @returns {number} the exit code
 */
export function resetApprovalCommand({ argv, configDir, out, err }) {
  const records = Object.entries(readControllers(configDir));
  const keyFile = path.join(configDir, 'approval-key.json');
  if (!argv.includes('--yes')) {
    err(
      `This removes the approval key and every controller (the Macs that can control this one; now ${records.length}): each is paired by code again. Run it again with --yes.`,
    );
    return 1;
  }
  try {
    // the relay links go first: a file that cannot be read stops everything before a controller or the key is touched
    const links = records.flatMap(([, record]) => (record.link ? [record.link] : []));
    // each stays a tombstone that tells its Mac it was removed (relayTombstone.mjs), until that Mac removes the pair
    const dropped = links.length ? retireEnrollments(configDir, links, Date.now()) : 0;
    // every record, believed or not, as the app's reset does (pairing.mjs `dropControllers`)
    createPairing({ configDir }).dropControllers();
    fs.rmSync(keyFile, { force: true });
    out(`Removed the approval key, controllers: ${records.length}, relay links: ${dropped}.`);
    out('Restart the Host to close links that are open, then set up pairing by code in MoPilot again.');
    return 0;
  } catch (error) {
    err(`Could not reset: ${error}`);
    return 1;
  }
}
