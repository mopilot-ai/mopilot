// What the fake ACP agent (fake-acp-agent.mjs) does the way dsh does: `--dump-config`, a session with no model
// provider (profile noProvider), and turns that fail with no DeepSeek key (profile needsKey).
import fs from 'node:fs';
import path from 'node:path';

/**
 * `--dump-config`: the composed profile tree the way dsh prints it, as YAML entries. The session-log row is off when
 * a --patch file turns it off, and the telemetry row's mode is DISABLED when the patch says so (as real dsh does;
 * DSH_TELEMETRY_DISABLED isn't reflected in the dump). dumpConfig 'ignoresPatch' is a version where the patch no
 * longer applies; 'telemetryIgnoresPatch' one where only the telemetry part doesn't.
 */
export function dumpConfig(argv, profile) {
  const patchAt = argv.indexOf('--patch');
  const patch = patchAt > 0 ? fs.readFileSync(argv[patchAt + 1], 'utf8') : '';
  const logOff = profile.dumpConfig !== 'ignoresPatch' && /- id: session-log-deepseek\s+config:\s+enabled: false/.test(patch);
  const telemetryOff =
    !['ignoresPatch', 'telemetryIgnoresPatch'].includes(profile.dumpConfig) &&
    /- id: session-telemetry-otel\s+config:\s+mode: DISABLED/.test(patch);
  const out = [
    '- id: session',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: session-log-deepseek',
    "  name: '@deepseek-ai/dsh-session-log-deepseek'",
    '  config:',
    `    enabled: ${logOff ? 'false' : 'true'}`,
    '- id: session-telemetry-otel',
    "  name: '@deepseek-ai/dsh-session-telemetry-otel'",
    '  config:',
    `    mode: ${telemetryOff ? 'DISABLED' : 'FEEDBACK_ONLY'}`,
  ];
  return out.join('\n') + '\n';
}

const FLASH = { value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' };
const MODEL = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: FLASH.value, options: [FLASH] };

/** Whether dsh would find a DeepSeek key: in its environment, or in $DSH_HOME/.env (default ~/.dsh). */
function hasKey(env) {
  if (env.DEEPSEEK_API_KEY) return true;
  try {
    const dir = env.DSH_HOME || path.join(env.HOME ?? '', '.dsh');
    return /^\s*DEEPSEEK_API_KEY\s*=\s*\S/m.test(fs.readFileSync(path.join(dir, '.env'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * What session/new adds, as dsh answers it; null when the profile asks for neither. noProvider is dsh with its acp row
 * left without a provider (0.2.0-rc.2 under MoPilot's old patch): no model (`configOptions: []`) until a
 * `provider` file in $FAKE_ACP_STATE stands for one. needsKey is dsh on its default model, key or not.
 */
export function providerOptions(profile, state) {
  if (profile.needsKey) return { configOptions: [MODEL] };
  if (!profile.noProvider) return null;
  return state && fs.existsSync(path.join(state, 'provider')) ? { configOptions: [MODEL] } : { configOptions: [] };
}

/** The error a turn ends with, in dsh's own words, when it has no provider or no key; null when it can run. */
export function turnError(profile, state, sessionId, env = process.env) {
  if (providerOptions(profile, state)?.configOptions.length === 0) return noProviderError(sessionId);
  if (profile.needsKey && !hasKey(env))
    return 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment';
  return null;
}

/** The error dsh's turn ends with when its agent has no provider: its own words (agent-loop). */
export const noProviderError = (sessionId) =>
  `Internal error: turn failed: agent "${sessionId}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`;
