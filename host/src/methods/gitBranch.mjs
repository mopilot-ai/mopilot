// The Host's handlers for `host.gitBranches` and `host.gitSwitch` (feature `gitBranch`, ../hostRead.mjs and ../hostWrite.mjs): the branch list behind a new chat's branch picker and the switch to a picked branch. Without a folder service the Host cannot serve them.
import { GIT_BRANCHES_METHOD, GIT_SWITCH_METHOD } from '../../../shared/host/gitBranch.mjs';
import { UnsupportedError } from '../errors.mjs';
import { createHostRead } from '../hostRead.mjs';
import { createHostWrite } from '../hostWrite.mjs';

/** @param {{ hostFs?: Parameters<typeof createHostWrite>[0]['hostFs'], audit?: Parameters<typeof createHostWrite>[0]['audit'] }} deps */
export default ({ hostFs, audit }) => {
  const read = hostFs ? createHostRead({ hostFs }) : null;
  const write = hostFs ? createHostWrite({ hostFs, audit }) : null;
  const need = () => {
    if (!read || !write) throw new UnsupportedError('This host cannot read or change a folder.');
    return { read, write };
  };
  return {
    handlers: {
      [GIT_BRANCHES_METHOD]: (/** @type {any} */ p) => need().read.branches(p),
      [GIT_SWITCH_METHOD]: (/** @type {any} */ p, /** @type {string} */ kind) => need().write.switchBranch(p, kind),
    },
  };
};
