// ACP conformance fixture for copilot.
import { ONCE, modes, COPILOT_MODE, cmds } from './helpers.mjs';
export default {
  rejectStdio: true,
  httpMcp: true,
  modes: modes(`${COPILOT_MODE}agent`, `${COPILOT_MODE}plan`, `${COPILOT_MODE}autopilot`),
  commands: cmds('fleet', 'agent', 'compact'),
  permissionOptions: ONCE,
};
