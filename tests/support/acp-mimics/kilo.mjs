// ACP conformance fixture for kilo, as Kilo 7.8.18 answered on a clean runner: MoPilot's two agents
// (KILO_CONFIG_CONTENT, mopilot-ask first as the default) beside Kilo's own modes. It does not verify an installed version.
import { ONCE, select } from './helpers.mjs';
export default {
  loadSession: true,
  resume: true,
  configOptions: [
    select('model', 'model', ['kilo/kilo-auto/free']),
    select('mode', 'mode', ['mopilot-ask', 'ask', 'code', 'debug', 'mopilot-full', 'orchestrator', 'plan']),
  ],
  permissionOptions: ONCE,
};
