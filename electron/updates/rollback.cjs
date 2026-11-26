// A rollback verifies the exact downloaded package and retires superseded native stages without claiming cancellation.
const { createHash } = require('node:crypto');
const { fs } = require('../platform/ports/fs.cjs');

async function verifyRollbackFile(file, update) {
  if (!update.rollback) return;
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of fs.createReadStream(file)) {
    size += bytes.length;
    hash.update(bytes);
  }
  if (size !== update.size || hash.digest('hex') !== update.sha256)
    throw new Error('The rollback download did not match its verified package. Check for updates to retry.');
}

/** Squirrel has no public cancel method: a revoked stage must stay blocked and its native-cache warning visible. */
function retireForRollback(updater, update) {
  if (!update.rollback || !updater.stagedArtifact) return;
  updater.stagedArtifact.valid = false;
  updater.stagedArtifact.rollbackRevoked = true;
  updater.stagedArtifact.stage?.cancel();
  updater.stopIdleWait();
  updater.set({ restartWhenIdle: false });
}

/** A revoked native stage still needs its source identity when retrying the safe replacement. */
function stagedVersion(updater, channel = updater.channel) {
  const artifact = updater.stagedArtifact;
  if (artifact?.channel === channel && artifact.rollbackRevoked)
    return artifact.available.rollback?.fromVersion ?? artifact.available.version;
  return artifact?.available.version ?? updater.state.available?.version;
}

module.exports = { verifyRollbackFile, retireForRollback, stagedVersion };
