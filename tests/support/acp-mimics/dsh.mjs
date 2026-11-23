// ACP conformance fixture for dsh.
import { select } from './helpers.mjs';
export default {
  resume: true,
  image: true,
  configOptions: [
    select('model', 'model', ['deepseek-flash', 'deepseek-v4-pro']),
    select('reasoning_effort', 'thought_level', ['high', 'off', 'low', 'max']),
  ],
  permissionOptions: [
    { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ],
  usage: true,
};
