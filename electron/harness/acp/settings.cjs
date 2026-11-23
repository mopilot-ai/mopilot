// A basic chat's own mode and config options (model, effort, …) set on its session: the choices its transcript
// recorded, or for a new chat the defaults new chats on its harness start with, which are then recorded too.
const { noteIgnored } = require('../../ignored.cjs');
const { acpModeControl, selectValues } = require('../../../shared/acpMode.mjs');
const { acpModelCatalog } = require('../../../shared/acpModels.mjs');

/** The mode's key among the recorded choices (config option ids are the others). */
const MODE = Symbol('mode');

/**
 * The choices a chat's transcript recorded: its last mode, and each config option's last value. `own` holds the keys
 * it has (MODE for the mode).
 */
function recordedOf(records) {
  let mode = null;
  const config = {};
  const own = new Set();
  for (const r of records) {
    if (r.t === 'mode' && typeof r.modeId === 'string') {
      mode = r.modeId;
      own.add(MODE);
    } else if (r.t === 'config' && typeof r.configId === 'string') {
      config[r.configId] = r.value;
      own.add(r.configId);
    }
  }
  return { mode, config, own };
}

/** The mode and config values a chat's transcript recorded, which its session is reopened on (its picker shows them). */
function recordedSettings(records) {
  const { mode, config } = recordedOf(records);
  return { ...(mode ? { mode } : {}), config };
}

/** What a config value is called among the option's values. */
const valueName = (opt, value) => selectValues(opt).find((v) => v.value === value)?.name ?? String(value);

/**
 * A reopened (or replaced) session starts from the agent's defaults: set the chat's own mode and config options
 * again, the last value of each that the transcript recorded. A new chat (`defaults` given) starts from its harness's
 * defaults, recorded as the chat's own so a reopen keeps them. One the agent no longer offers, or rejects, is
 * skipped: the agent keeps its value, which chat.state still shows, and the result names it.
 * @param {any} host the AcpHost
 * @param {any} chat
 * @param {{ mode?: string | null, config?: Record<string, unknown> } | null} [defaults]
 * @returns {Promise<string[]>} what didn't apply, as "<option> <value>"
 */
async function applySettings(host, chat, defaults = null) {
  host.assertChatCurrent(chat);
  // what the transcript holds wins, and is not recorded again: only a default is
  const rec = recordedOf(await host.items.readAsync(chat.key));
  host.assertChatCurrent(chat);
  const own = rec.own;
  let mode = rec.mode ?? (typeof defaults?.mode === 'string' ? defaults.mode : null);
  const config = new Map([...Object.entries(defaults?.config ?? {}), ...Object.entries(rec.config)]);
  const st = chat.state;
  const control = acpModeControl(st);
  // a mode the agent declares as a config option (opencode's build and plan) is set through that option
  const modeOption = control?.via === 'config' ? control.configId : null;
  if (mode && modeOption && !config.has(modeOption)) {
    config.set(modeOption, mode);
    if (own.has(MODE)) own.add(modeOption);
  }
  const failed = [];
  const keep = (rec) =>
    defaults && !own.has(rec.t === 'mode' ? MODE : rec.configId) && host.items.append(chat.key, { ...rec, at: host.now() });
  // the agent's own current_mode_update echo of what is set here is not a new choice
  chat.reapplying = true;
  try {
    if (mode && control?.via === 'mode') {
      if (!control.options.some((m) => m.id === mode)) failed.push(`mode ${mode}`);
      else if (mode === control.current) keep({ t: 'mode', modeId: mode });
      else
        try {
          await chat.agent.request('session/set_mode', { sessionId: chat.sessionId, modeId: mode });
          st.modes = { ...st.modes, currentModeId: mode };
          keep({ t: 'mode', modeId: mode });
        } catch (error) {
          noteIgnored("set an ACP chat's mode again", error);
          failed.push(`mode ${mode}`);
        }
    }
    for (const [configId, value] of config) {
      host.assertChatCurrent(chat);
      const opt = (st.configOptions ?? []).find((o) => o.id === configId);
      if (!opt || (opt.type === 'select' && !selectValues(opt).some((v) => v.value === value))) {
        failed.push(`${opt?.name ?? configId} ${String(value)}`);
        continue;
      }
      if (opt.currentValue === value) {
        keep({ t: 'config', configId, value });
        continue;
      }
      try {
        const res = await chat.agent.request('session/set_config_option', { sessionId: chat.sessionId, configId, value });
        st.configOptions = Array.isArray(res?.configOptions)
          ? res.configOptions
          : st.configOptions.map((o) => (o.id === configId ? { ...o, currentValue: value } : o));
        keep({ t: 'config', configId, value });
      } catch (error) {
        noteIgnored(`set an ACP chat's ${configId} again`, error);
        failed.push(`${opt.name ?? configId} ${valueName(opt, value)}`);
      }
      host.assertChatCurrent(chat);
    }
  } finally {
    chat.reapplying = false;
  }
  return failed;
}

/**
 * What a harness offers new chats, from a session/new answer: its modes and config options with the agent's own
 * current values, plus read-only models from older native ACP interfaces. Null when it declares none.
 */
function catalogOf(res) {
  const modes = res?.modes && Array.isArray(res.modes.availableModes) ? res.modes : null;
  const configOptions = Array.isArray(res?.configOptions) ? res.configOptions : null;
  const models = acpModelCatalog(res?.models);
  return modes || configOptions || models ? { modes, configOptions, ...(models ? { models } : {}) } : null;
}

module.exports = { applySettings, catalogOf, recordedOf, recordedSettings };
