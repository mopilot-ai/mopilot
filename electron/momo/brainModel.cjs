// What MoMo's brain picks besides its harness (#2139): the brain as saved, the model each family keeps for a chat, and the
// pin a MoMo chat's turns run on, kept in its file: the Claude Code model (meta.momoModel, #2304) and the effort on Codex and
// Claude Code alike (meta.momoEffort), which each harness reads over a window's push and a switch's config
// (session/adapterSettings.cjs), so a reload, a relaunch or a window that hasn't read the chat yet can't put it back on
// the default. Only main writes it.
const { familyOf, byFamily } = require('../session/contract/route.cjs');
const { MOMO_MODEL_KEY, MOMO_EFFORT_KEY, momoModelOf, momoEffortOf } = require('../../shared/momoChat.mjs');
const { isHarnessKind } = require('../../shared/defaultHarness.mjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

/**
 * What the brain picks on each family besides the harness: the model the chat keeps as its own (what its turns run on
 * unless a message names one) and the harness's default model (for a switch to it). null: a basic harness, with one
 * sign-in and its model and thought level session options its native session keeps, so its brain names neither.
 * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, { model: (o: any, chatId: string, model: string) => void, defaultModel: (prefs: any) => string | null } | null>}
 */
const PICKS = {
  codex: {
    // Codex turns read the chat's own config (harness/codexParams.cjs)
    model: (o, chatId, model) => {
      const config = o.chats.record(chatId).meta.config;
      o.chats.patchMeta(chatId, { config: { ...(isJsonRecord(config) ? config : {}), model } });
    },
    defaultModel: (prefs) => prefs?.model ?? null,
  },
  claude: {
    // ClaudeTurns keeps the chat's own pick with the login it runs on (harness/claude/adapter.cjs setOwn), below the pin
    model: (o, chatId, model) => {
      const claude = o.accounts.claude;
      claude.setOwn(chatId, { model, effort: claude.own.get(chatId)?.effort ?? null, account: claude.pickOf(chatId) });
    },
    defaultModel: (prefs) => prefs?.claudeSelection?.model ?? null,
  },
  acp: null,
};

const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * @typedef {{ harness: string, account: string | null, model: string | null, modelLabel: string | null, effort: string | null }} Brain
 *   effort: null is the model's default
 */

/**
 * A brain as saved or asked for, or null when it names no harness. A basic harness's brain names no account, model or effort.
 * @returns {Brain | null}
 */
function brainOf(v) {
  const r = isJsonRecord(v) ? v : {};
  if (!isHarnessKind(r.harness)) return null;
  const picks = byFamily(PICKS, r.harness) !== null;
  return {
    harness: r.harness,
    account: picks ? str(r.account) : null,
    model: picks ? str(r.model) : null,
    modelLabel: picks ? str(r.modelLabel) : null,
    effort: picks ? str(r.effort) : null,
  };
}

/**
 * Pin the chat to `brain`'s model (Claude Code's) and effort (Codex's and Claude Code's); a brain on a harness without
 * one clears it. Whether it changed.
 * @param {{ records: Map<string, { meta?: unknown }>, patchMeta: (id: string, patch: object) => boolean }} chats
 * @param {string} chatId
 * @param {{ harness: string, model: string | null, effort?: string | null }} brain
 */
function pinModel(chats, chatId, brain) {
  const model = familyOf(brain.harness) === 'claude' ? brain.model : null;
  const effort = byFamily(PICKS, brain.harness) ? (brain.effort ?? null) : null;
  const meta = chats.records.get(chatId)?.meta;
  if (momoModelOf(meta) === model && momoEffortOf(meta) === effort) return false;
  return chats.patchMeta(chatId, { [MOMO_MODEL_KEY]: model, [MOMO_EFFORT_KEY]: effort });
}

/** An ACP model is owned by its native session; first-tier switches require a selected model. */
function switchModel(brain, picks, prefs) {
  return brain.model ?? (picks ? picks.defaultModel(prefs) : '');
}

module.exports = { pinModel, switchModel, brainOf, PICKS };
