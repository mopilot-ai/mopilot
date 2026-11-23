// `mopilot-host enroll` (add by command): the input (credential and one-time code) comes on standard input only and is never printed.
import { EnrollError, parseInput } from './relayEnroll.mjs';
import { createPairing } from './pairing.mjs';

/**
 * @param {object} o
 * @param {{ configDir: string, socketPath: string }} o.paths
 * @param {(NodeJS.ReadableStream & { isTTY?: boolean }) | null} o.stdin
 * @param {typeof import('./relayEnroll.mjs').enroll} o.joinRelay
 * @param {(line: string) => void} o.out @param {(line: string) => void} o.err
 * @returns {Promise<number>} the exit code
 */
export async function enrollCommand({ paths, stdin, joinRelay, out, err }) {
  try {
    if (!stdin) throw new EnrollError('input', 'Run the whole command MoPilot showed.');
    const chunks = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    const input = parseInput(Buffer.concat(chunks).toString('utf8'));
    const pairing = createPairing({ configDir: paths.configDir });
    await joinRelay({ input, configDir: paths.configDir, socketPath: paths.socketPath, pairing, say: err });
    out('This machine joined MoPilot.');
    return 0;
  } catch (e) {
    err(`MoPilot: ${e instanceof EnrollError ? e.message : 'This machine could not join MoPilot.'}`);
    return 1;
  }
}
