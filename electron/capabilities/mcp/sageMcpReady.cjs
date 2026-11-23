// Whether sage-mcp can serve a harness here: the file is there, and the Rust core's peer check, which every hello goes through (socket.cjs verifyPeer), works on this machine.
const { fs: fsPort } = require('../../platform/ports/fs.cjs');
const { core, coreSyncCall } = require('../../platform/core.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/**
 * Whether this process can check who connects to a tool socket, shown by running the check (`caps.ready`): one that fails
 * here would refuse every hello while the tools show as reachable. No core, or no answer, is not ready: a Host without
 * its core still says so in `status`.
 * @param {ReturnType<typeof core> | null} [addon]
 */
function peerCheckReady(addon = core()) {
  // asked once a run: without the note, tools that went missing for a moment's failure would leave no word of why
  try {
    if (coreSyncCall(addon, 'caps.ready', null) === true) return true;
    noteIgnored('check who connects to the tool sockets', new Error('the Rust core cannot run the peer check here'));
  } catch (error) {
    noteIgnored('check who connects to the tool sockets', error);
  }
  return false;
}

/**
 * Whether sage-mcp can serve a harness here: it exists and the peer check can answer, so the tools are reported missing
 * rather than reachable when every hello would be refused.
 * @param {string} file socket.cjs sageMcpPath's answer, or the portable sage-mcp's script
 * @param {{ exists?: (f: string) => boolean, addon?: ReturnType<typeof core> | null }} [o]
 */
function sageMcpReady(file, { exists = (f) => fsPort.existsSync(f), addon = core() } = {}) {
  return exists(file) && peerCheckReady(addon);
}

module.exports = { sageMcpReady, peerCheckReady };
