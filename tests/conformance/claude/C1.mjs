// Startup the way Sage starts the CLI; what the init system message and the result carry.
import { open, brief } from '../lib/claude.mjs';

export const id = 'C1';
export const title = 'Startup via SDK like Sage; init system message';
export const timeoutMs = 240000;

export default async function run(ctx) {
  const s = open(ctx, 'session', { permissionMode: 'default', includePartialMessages: true });
  await s.q.initializationResult();
  const res = await s.turn('Reply with just the word OK.', {}, 120000);
  const init = s.msgs.find((m) => m.type === 'system' && m.subtype === 'init');
  const observed = {
    claude_code_version: init?.claude_code_version,
    tools: init?.tools?.length,
    slash_commands: init?.slash_commands?.length,
    terminal_slash_commands: init?.terminal_slash_commands,
    permissionMode: init?.permissionMode,
    output_style: init?.output_style,
    capabilities: init?.capabilities,
    fast_mode_disabled_reason: init?.fast_mode_disabled_reason ?? res?.fast_mode_disabled_reason,
    resultHasFastModeState: res ? 'fast_mode_state' in res : false,
    result: brief(res),
    messageTypes: [...new Set(s.msgs.map((m) => `${m.type}/${m.subtype ?? ''}`))],
  };
  return ctx.result(observed, {
    'init reports the CLI version': init?.claude_code_version === ctx.cliVersion,
    'init lists tools and slash commands': observed.tools > 0 && observed.slash_commands > 0,
    'init.permissionMode is default': init?.permissionMode === 'default',
    'turn succeeds': res?.subtype === 'success',
    'result carries fast_mode_state': observed.resultHasFastModeState,
  });
}
