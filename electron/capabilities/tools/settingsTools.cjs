// get_settings and set_setting, as Claude Desktop's ccd_settings ones, over an explicit allowlist of MoPilot's
// user-facing display and sidebar preferences, the same on every harness. A set always asks the user first (a consent
// card). Nothing about permissions, sandboxing, the browser, computer use, accounts, keybindings, notifications of
// approvals or file locations is on the list, so no call can raise what an agent may do above what its chat has.
const { ToolError } = require('../contract/registry.cjs');

const bool = (v) => typeof v === 'boolean';
const oneOf =
  (...values) =>
  (v) =>
    values.includes(v);

/**
 * The settings an agent may read and change: key (the saved prefs key) -> label, and which values are valid.
 * @type {Record<string, { label: string, options?: string[], valid: (v: unknown) => boolean }>}
 */
const SETTINGS = {
  theme: { label: 'Theme', options: ['system', 'light', 'dark'], valid: oneOf('system', 'light', 'dark') },
  sendWith: { label: 'Send messages with', options: ['enter', 'cmdEnter'], valid: oneOf('enter', 'cmdEnter') },
  followUp: { label: 'Follow-up while a turn runs', options: ['queue', 'steer'], valid: oneOf('queue', 'steer') },
  showReasoning: { label: 'Show reasoning', options: ['true', 'false'], valid: bool },
  wrapCode: { label: 'Wrap long code lines', options: ['true', 'false'], valid: bool },
  defaultTerminal: { label: 'Terminal position', options: ['bottom', 'right'], valid: oneOf('bottom', 'right') },
  changesScope: { label: 'Changes pane scope', options: ['turn', 'uncommitted', 'branch'], valid: oneOf('turn', 'uncommitted', 'branch') },
  showChatHarness: { label: 'Show each chat’s harness in the sidebar', options: ['true', 'false'], valid: bool },
  sidebarOrganize: { label: 'Sidebar layout', options: ['project', 'list'], valid: oneOf('project', 'list') },
  projectSort: { label: 'Project order', options: ['custom', 'updated', 'name'], valid: oneOf('custom', 'updated', 'name') },
  chatSort: { label: 'Chat order', options: ['updated', 'manual'], valid: oneOf('updated', 'manual') },
};
const KEYS = Object.keys(SETTINGS);

/** A value as the user reads it on the card. */
const shown = (v) => (typeof v === 'string' ? `“${v}”` : String(v));

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat that called
 * @param {() => any} o.prefs the saved prefs
 * @param {(set: Record<string, unknown>) => boolean} o.patchPrefs saves prefs and tells every window
 * @param {(chatId: string, summary: string, signal: AbortSignal | null) => Promise<boolean>} o.ask the user's answer to a consent card
 * @returns {() => void} removes the tools
 */
function registerSettingsTools(registry, { owner, prefs, patchPrefs, ask }) {
  const add = (name, description, properties, required, policy, handler) =>
    registry.register({
      name,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      policy,
      authorizesItself: true,
      handler: async (args, ctx) => {
        const caller = owner(ctx);
        if (!caller) throw new ToolError('The caller does not own this chat segment', 'no_owner');
        return handler(args, caller, ctx);
      },
    });
  const row = (key) => {
    const saved = prefs()?.[key];
    const set = saved !== undefined && SETTINGS[key].valid(saved);
    return { key, label: SETTINGS[key].label, options: SETTINGS[key].options, value: set ? saved : null, default: !set };
  };
  const disposers = [
    add(
      'get_settings',
      `Read MoPilot's user-facing display and sidebar settings: ${KEYS.join(', ')}. Each row has the key, a label, the valid options, and the saved value (null with default true while the app default applies). Security, permission and browser settings are not available here. Change one with set_setting.`,
      { keys: { type: 'array', items: { type: 'string' }, description: 'Only these keys (default: all of them)' } },
      [],
      'observe',
      async (args) => {
        const wanted = args.keys === undefined ? KEYS : args.keys.map(String);
        const unknown = wanted.filter((k) => !KEYS.includes(k));
        if (unknown.length) throw new ToolError(`Unknown setting: ${unknown.join(', ')}. Available: ${KEYS.join(', ')}.`, 'bad_args');
        return { settings: wanted.map(row) };
      },
    ),
    add(
      'set_setting',
      `Change one of the settings get_settings lists. The user is asked to approve every change in a card, so say why in your message first; do not retry a denied change. Keys: ${KEYS.join(', ')}.`,
      {
        key: { type: 'string' },
        value: { type: ['string', 'boolean'], description: 'A value from the setting’s options (booleans as true or false)' },
      },
      ['key', 'value'],
      'act',
      async (args, caller, ctx) => {
        const key = String(args.key);
        const spec = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : null;
        if (!spec) throw new ToolError(`“${key}” can't be changed from here. Available: ${KEYS.join(', ')}.`, 'not_allowed');
        // booleans are accepted as the strings a model sometimes writes them as
        const value = args.value === 'true' ? true : args.value === 'false' ? false : args.value;
        if (!spec.valid(value)) throw new ToolError(`${spec.label} takes one of: ${spec.options?.join(', ')}.`, 'bad_args');
        const before = row(key);
        if (before.value === value) return { key, value, changed: false, said: 'It is already set to that.' };
        const label = spec.label;
        if (!(await ask(caller, `set ${label} to ${shown(value)}`, ctx.signal)))
          throw new ToolError('The user did not allow this change. Do not retry it.', 'denied');
        if (!patchPrefs({ [key]: value })) throw new ToolError("Couldn't save the setting", 'save_failed');
        return { key, value, changed: true, said: `${label} is now ${shown(value)}.` };
      },
    ),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerSettingsTools, SETTINGS };
