// Shared fixture builders for the ACP conformance mimics.
export const ONCE = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
/** @param {string} id @param {string} category @param {string[]} values */
export const select = (id, category, values) => ({
  id,
  name: id,
  category,
  type: 'select',
  currentValue: values[0],
  options: values.map((v) => ({ value: v, name: v })),
});
/** @param {...string} ids */
export const modes = (...ids) => ({ currentModeId: ids[0], availableModes: ids.map((id) => ({ id, name: id })) });
export const COPILOT_MODE = 'https://agentclientprotocol.com/protocol/session-modes#';
/** @param {...string} names */
export const cmds = (...names) => names.map((name) => ({ name, description: `${name} command` }));
