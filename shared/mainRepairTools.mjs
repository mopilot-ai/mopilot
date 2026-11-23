// Defines repair tool metadata once for registration and cross-chat isolation without importing higher-layer services.
/** @type {[string, string, string, object, string[], string][]} */
const specs = [
  [
    'configure_main_repair',
    'act',
    'Enable or revoke automatic fix-forward repair for this chat’s repository. Enable only after the user explicitly grants repository-scoped automatic repair including PRs and merges; requires their current turn. One fresh worker claims each trusted main-red failure in an isolated worktree. Continues while MoPilot is open and resumes after restart; it inherits this chat’s harness/settings, never its conversation. Ordinary feature work can continue.',
    { enabled: { type: 'boolean' } },
    ['enabled'],
    'configure',
  ],
  [
    'request_main_repair',
    'act',
    'Reconcile the repository’s already-authorized main repairs now. Does not grant authority or accept a prompt, harness, folder or parent history. Exactly one owner handles each break; continue independent work here and use status for errors or recovery evidence. A repair worker cannot request another repair.',
    {},
    [],
    'request',
  ],
  [
    'get_main_repair',
    'observe',
    'Read this repository’s saved automatic repair authority and latest worker/recovery states. A merged repair remains verifying until its assigned failure passed on main containing the fix.',
    {},
    [],
    'status',
  ],
];
export const MAIN_REPAIR_SPECS = Object.freeze(specs);
export const MAIN_REPAIR_TOOLS = Object.freeze(specs.map(([name]) => name));
