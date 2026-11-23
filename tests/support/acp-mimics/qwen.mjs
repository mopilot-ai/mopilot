// ACP conformance fixture for qwen.
import { ONCE, modes, cmds } from './helpers.mjs';
export default {
  modes: modes('default', 'plan', 'auto-edit', 'auto', 'yolo'),
  commands: cmds('goal', 'plan', 'review', 'compress', 'loop'),
  permissionOptions: ONCE,
};
