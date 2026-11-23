// A Claude turn's model, effort, permission and directory grants come from its own saved settings before global new-chat defaults.
const { claudePermissionFor } = require('../../../shared/claudeSettings.mjs');
const { claudeDefaultModel } = require('../../../shared/claudeModels.mjs');
const { chatModelChoice } = require('../../../shared/modelChoice.mjs');

function claudeTurnSettings(adapter, chatId, opts) {
  const prefs = adapter.prefs() || {};
  const account = adapter.accountOf(chatId);
  const saved = adapter.savedSettings(chatId) || {};
  const base = { ...(prefs.claudeSelection || { model: null, effort: null, fast: false }), ...saved };
  const own = adapter.own.get(chatId);
  const model = adapter.pinnedModel(chatId) ?? chatModelChoice(saved, own?.model, base.model);
  // a MoMo chat's effort is pinned by its brain, with or without a model it names
  const pinnedEffort = adapter.pinnedEffort(chatId);
  const sel = {
    ...base,
    ...(model ? { model, effort: (own?.model === model ? own.effort : null) ?? base.effort } : {}),
    ...(pinnedEffort ? { effort: pinnedEffort } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  };
  const probe = adapter.probeInfo(account);
  const selectionModel = chatModelChoice(saved, sel.model, base.model);
  // A message's or MoMo brain's explicit model overrides the chat's Automatic choice for that run.
  const requested = opts.model ?? adapter.pinnedModel(chatId) ?? selectionModel;
  const recommended = claudeDefaultModel(probe?.models ?? []);
  const picked = (probe?.models ?? []).find((m) => m.value === (requested ?? recommended));
  const permission = opts.plan
    ? 'plan'
    : claudePermissionFor(
        opts.permission ?? saved.permission ?? prefs.permission ?? 'default',
        picked ? { autoMode: !!picked.supportsAutoMode } : undefined,
      );
  const blocked = adapter.fastBlocked ?? probe?.fastBlocked ?? null;
  return {
    account,
    prefs,
    model: requested ?? recommended,
    selectionModel: requested,
    effort: sel.effort ?? null,
    permission,
    basePermission: saved.permission === 'plan' ? (saved.planBasePermission ?? 'default') : (saved.permission ?? prefs.permission),
    fast: !!sel.fast && !blocked,
    picked: requested ?? (picked ? picked.value : null),
    ...((opts.additionalDirectories ?? saved.additionalDirectories)
      ? { additionalDirectories: opts.additionalDirectories ?? saved.additionalDirectories }
      : {}),
  };
}

module.exports = { claudeTurnSettings };
