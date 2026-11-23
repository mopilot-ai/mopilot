// The Host's handler for `host.gitTurnDiff` (feature `gitTurnDiff`, ../hostTurnTree.mjs): what one turn changed in a chat's folder. It also takes the turns' trees: it listens to the stream's turn events (every agent's) and hears the folder each message names from the `sending` event of the runtime's host. Without a folder service the Host cannot serve it.
import path from 'node:path';
import { GIT_TURN_DIFF_METHOD } from '../../../shared/host/gitTurnDiff.mjs';
import { UnsupportedError } from '../errors.mjs';
import { createHostTurnTree } from '../hostTurnTree.mjs';

/** @param {{ hostFs?: Parameters<typeof createHostTurnTree>[0]['hostFs'], runtime?: any, dataDir?: string }} deps */
export default ({ hostFs, runtime, dataDir }) => {
  const trees =
    hostFs && runtime?.host ? createHostTurnTree({ hostFs, ...(dataDir ? { file: path.join(dataDir, 'turn-trees.json') } : {}) }) : null;
  if (trees) {
    runtime.host.on('event', (/** @type {any} */ event) => trees.onEvent(event));
    // the folder a message works in, told by the chat effect every agent's message passes (./chatEffects.mjs) before it is sent
    runtime.host.on('sending', (/** @type {any} */ p) => trees.note(p?.key, p?.cwd));
  }
  return {
    handlers: {
      [GIT_TURN_DIFF_METHOD]: (/** @type {any} */ p) => {
        if (!trees) throw new UnsupportedError('This host cannot read a turn’s changes.');
        return trees.diff(p);
      },
    },
  };
};
