// Pure ACP session-state reduction shared by its native host and the stable-chat controller.
export function acpStateUpdate(prev, u) {
  const cur = prev ?? { modes: null, configOptions: null, commands: null, usage: null };
  switch (u?.sessionUpdate) {
    case 'available_commands_update':
      return { ...cur, commands: Array.isArray(u.availableCommands) ? u.availableCommands : [] };
    case 'current_mode_update':
      return cur.modes
        ? { ...cur, modes: { ...cur.modes, currentModeId: u.currentModeId } }
        : { ...cur, modes: { currentModeId: u.currentModeId, availableModes: [] } };
    case 'config_option_update':
      return Array.isArray(u.configOptions) ? { ...cur, configOptions: u.configOptions } : null;
    case 'usage_update':
      return { ...cur, usage: { used: u.used ?? null, size: u.size ?? null } };
    default:
      return null;
  }
}
