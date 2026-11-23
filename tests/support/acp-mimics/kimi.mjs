// ACP conformance fixture for kimi.
import { select, cmds } from './helpers.mjs';
export default {
  loadSession: true,
  resume: true,
  image: true,
  configOptions: [
    select('model', 'model', ['kimi-k3', 'kimi-k3-turbo']),
    select('thinking', 'thought_level', ['on', 'off']),
    // real Kimi Code's ACP_MODES
    select('mode', 'mode', ['default', 'plan', 'auto', 'yolo']),
  ],
  commands: cmds('goal', 'swarm', 'init', 'skill:review'),
  authMethods: [{ id: 'device', name: 'Log in with a device code' }],
};
