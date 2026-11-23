// The Host's handlers for `host.gitCommit` and `host.gitDiscard` (feature `gitWrite`, ./hostWrite.mjs): the writes of a chat's folder behind the Changes pane. Without a folder service the Host cannot serve them.
import { GIT_COMMIT_METHOD, GIT_DISCARD_METHOD } from '../../../shared/host/gitWrite.mjs';
import { UnsupportedError } from '../errors.mjs';
import { createHostWrite } from '../hostWrite.mjs';

/** @param {{ hostFs?: Parameters<typeof createHostWrite>[0]['hostFs'], audit?: Parameters<typeof createHostWrite>[0]['audit'] }} deps */
export default ({ hostFs, audit }) => {
  const write = hostFs ? createHostWrite({ hostFs, audit }) : null;
  const need = () => {
    if (!write) throw new UnsupportedError('This host cannot change a folder.');
    return write;
  };
  return {
    handlers: {
      [GIT_COMMIT_METHOD]: (/** @type {any} */ p, /** @type {string} */ kind) => need().commit(p, kind),
      [GIT_DISCARD_METHOD]: (/** @type {any} */ p, /** @type {string} */ kind) => need().discard(p, kind),
    },
  };
};
