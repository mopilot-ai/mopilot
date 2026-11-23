// Codex Browser Use facade: per-thread backends, socket framing and CDP policy are implemented in iabBackend/.
const { IabBackend } = require('./iabBackend/backend.cjs');
const { IabBackends, mainIabBackends } = require('./iabBackend/manager.cjs');
const { Peer, FrameDecoder, encodeFrame } = require('./iabBackend/wire.cjs');
const { cdpPolicy, cdpClass, CDP_DOMAINS, CDP_METHODS, CDP_CLASSES, autoAttachParams, urlAllowed } = require('./iabBackend/policy.cjs');
const { pluginBrowserEnv, verifyDescendant } = require('./iabBackend/environment.cjs');
const { SOCKET_DIR } = require('./iabBackend/protocol.cjs');

module.exports = {
  IabBackends,
  mainIabBackends,
  IabBackend,
  Peer,
  FrameDecoder,
  encodeFrame,
  cdpPolicy,
  cdpClass,
  CDP_DOMAINS,
  CDP_METHODS,
  CDP_CLASSES,
  autoAttachParams,
  urlAllowed,
  pluginBrowserEnv,
  verifyDescendant,
  SOCKET_DIR,
};
