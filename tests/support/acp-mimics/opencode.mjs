// ACP conformance fixture for opencode.
import { ONCE, select, cmds } from './helpers.mjs';
export default {
  loadSession: true,
  resume: true,
  // with MoPilot's two agents (quirks/opencode.cjs, OPENCODE_CONFIG_CONTENT) beside its own build and plan
  configOptions: [
    select('model', 'model', ['opencode/big-pickle']),
    select('mode', 'mode', ['build', 'plan', 'mopilot-ask', 'mopilot-full']),
  ],
  commands: cmds('init', 'review', 'compact'),
  permissionOptions: ONCE,
};
