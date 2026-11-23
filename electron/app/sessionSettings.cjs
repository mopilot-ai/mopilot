// A chat's model, effort, fast mode and permission as main reads and changes them for the session-management tools
// (capabilities/tools/sessionControl.cjs), with no chat window needed and the same outcome on every harness: Codex and
// Claude Code keep them in the chat's saved config (and Claude's own pick for its live CLI), an ACP agent takes them as
// the config options and modes it declares. A harness without a setting answers unavailable.
const { parseKind } = require('../../shared/harnessKind.mjs');
const { appPermission } = require('../../shared/permissionMenu.mjs');
const { claudeModels } = require('../../shared/claudeModels.mjs');
const { acpModeControl, selectValues } = require('../../shared/acpMode.mjs');
const { saveMeta } = require('../../shared/metaSave.mjs');
const { configuredSwitchModel } = require('../../shared/switchModel.mjs');
const { modelLabel } = require('../../shared/modelLabels.mjs');

/** What an ACP mode's anchor tier is called as a permission, and the tiers' order. */
const TIER_PERMISSION = { readOnly: 'read-only', ask: 'default', auto: 'auto-review', full: 'full-access' };
const TIER_RANK = { readOnly: 0, ask: 1, auto: 2, full: 3 };
const PERMISSION_TIER = { 'read-only': 'readOnly', default: 'ask', 'auto-review': 'auto', 'full-access': 'full' };

/** An error the tool layer reports with this code (capabilities/tools/sessionKit.cjs). */
const coded = (message, code) => Object.assign(new Error(message), { code });
const unavailable = (message) => coded(message, 'unavailable');
const familyOf = (kind) => /** @type {NonNullable<ReturnType<typeof parseKind>>} */ (parseKind(kind)).family;
const option = (acp, category) =>
  (Array.isArray(acp?.configOptions) ? acp.configOptions : []).find((o) => o?.category === category && o.type === 'select') ?? null;
const pick = (ids, wanted) => ids.find((id) => id === wanted) ?? ids.find((id) => id.toLowerCase() === wanted.toLowerCase()) ?? null;

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services: chats, controller, codex, claudeTurns, acpHost
 * @param {() => any} o.prefs the app's prefs
 * @param {(kind: string) => Promise<boolean>} [o.usable] whether a harness can take a chat now
 */
function createSessionSettings({ live, prefs, usable = async () => true }) {
  const ref = (id) => live.controller.ref(id);
  const config = (id) => live.chats.records.get(id)?.meta?.config ?? {};
  const state = (id) => live.controller.state.get(id);
  const save = (id, patch) => {
    // a value the chat already has is saved
    if (!saveMeta(live.chats, id, { config: { ...config(id), ...patch } }))
      throw coded('The chat’s settings could not be saved.', 'save_failed');
  };

  /** The models a Codex or Claude Code chat can use, with the efforts each offers. */
  const models = {
    async codex() {
      const list = (await live.codex.modelList()).data;
      return list
        .filter((m) => !m.hidden)
        .map((m) => ({ id: m.model, efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort) }));
    },
    async claude(id) {
      const info = live.claudeTurns.probeInfo(live.claudeTurns.accountOf(id));
      return claudeModels(info?.models ?? []).map((m) => ({ id: m.id, efforts: m.efforts, fast: m.fast }));
    },
  };

  /** The chat's model, effort, permission and fast mode as they are now (fast: undefined where the harness has none). */
  const SETTINGS = {
    codex(id) {
      const p = prefs();
      const c = config(id);
      // a key the chat has, even null, wins over the user's default (harness/codexParams.cjs chatPrefs)
      const mine = (k) => (k in c ? (c[k] ?? null) : (p[k] ?? null));
      return {
        model: mine('model'),
        effort: mine('effort'),
        permission: state(id)?.plan ? 'plan' : (appPermission(state(id)?.permission) ?? mine('permission') ?? 'default'),
        fast: mine('serviceTier') === 'priority',
      };
    },
    claude(id) {
      const s = live.claudeTurns.settings(id, {});
      return {
        model: s.model ?? null,
        effort: s.effort ?? null,
        permission: state(id)?.plan ? 'plan' : (appPermission(state(id)?.permission) ?? appPermission(s.permission) ?? null),
        fast: s.fast === true,
      };
    },
    acp(id) {
      const acp = state(id)?.acp;
      // how much the agent's current mode may do, by the anchor its harness gives that mode
      const mode = acpModeControl(acp)?.current;
      const tier = mode && acp?.anchors && Object.hasOwn(acp.anchors, mode) ? acp.anchors[mode] : null;
      const permission = TIER_PERMISSION[tier] ?? null;
      return {
        model: option(acp, 'model')?.currentValue ?? null,
        effort: option(acp, 'thought_level')?.currentValue ?? null,
        permission,
        fast: undefined,
      };
    },
  };

  const SET_MODEL = {
    async codex(id, wanted) {
      const list = await models.codex();
      const model = pick(
        list.map((m) => m.id),
        wanted,
      );
      if (!model)
        throw coded(
          `Unknown model ${JSON.stringify(wanted)}. Available: ${list.map((m) => JSON.stringify(m.id)).join(', ')}.`,
          'unknown_model',
        );
      save(id, { model });
      return model;
    },
    async claude(id, wanted) {
      const list = await models.claude(id);
      if (!list.length) throw unavailable('The app has not reported its Claude model list yet; try again in a moment.');
      const model = pick(
        list.map((m) => m.id),
        wanted,
      );
      if (!model)
        throw coded(
          `Unknown model ${JSON.stringify(wanted)}. Available: ${list.map((m) => JSON.stringify(m.id)).join(', ')}.`,
          'unknown_model',
        );
      live.claudeTurns.setOwn(id, {
        model,
        effort: live.claudeTurns.settings(id, {}).effort ?? null,
        account: live.claudeTurns.pickOf(id),
      });
      save(id, { model });
      return model;
    },
    async acp(id, wanted) {
      const opt = option(state(id)?.acp, 'model');
      if (!opt) throw unavailable('This agent declares no model setting.');
      const values = selectValues(opt).map((v) => String(v.value));
      const model = pick(values, wanted);
      if (!model)
        throw coded(
          `Unknown model ${JSON.stringify(wanted)}. Available: ${values.map((v) => JSON.stringify(v)).join(', ')}.`,
          'unknown_model',
        );
      await live.acpHost.setConfigOption(ref(id).key, opt.id, model);
      return model;
    },
  };

  const offered = (list, model, effort) => {
    const efforts = list.find((m) => m.id === model)?.efforts ?? [];
    if (efforts.length && !efforts.includes(effort))
      throw coded(`Effort ${effort} is not offered for ${JSON.stringify(model)}; it offers ${efforts.join(', ')}.`, 'unknown_effort');
  };
  const SET_EFFORT = {
    async codex(id, effort) {
      offered(await models.codex(), SETTINGS.codex(id).model, effort);
      save(id, { effort });
      return effort;
    },
    async claude(id, effort) {
      const s = SETTINGS.claude(id);
      offered(await models.claude(id), s.model, effort);
      live.claudeTurns.setOwn(id, { model: s.model, effort, account: live.claudeTurns.pickOf(id) });
      save(id, { effort });
      return effort;
    },
    async acp(id, effort) {
      const opt = option(state(id)?.acp, 'thought_level');
      if (!opt) throw unavailable('This agent declares no thought-level setting.');
      const values = selectValues(opt).map((v) => String(v.value));
      const level = pick(values, effort);
      if (!level) throw coded(`Effort ${effort} is not offered by this agent; it offers ${values.join(', ')}.`, 'unknown_effort');
      await live.acpHost.setConfigOption(ref(id).key, opt.id, level);
      return level;
    },
  };

  const SET_PERMISSION = {
    async codex(id, mode) {
      save(id, { permission: mode });
      return mode;
    },
    async claude(id, mode) {
      save(id, { permission: mode });
      // a live CLI takes it now, mid-turn too
      await live.claudeTurns.permissionChanged(id);
      return mode;
    },
    async acp(id, mode) {
      const acp = state(id)?.acp;
      const control = acpModeControl(acp);
      if (!control) throw unavailable('This agent declares no permission modes.');
      const anchors = acp?.anchors && typeof acp.anchors === 'object' ? acp.anchors : {};
      const max = TIER_RANK[PERMISSION_TIER[mode]];
      // the mode closest to the one asked for that never does more than it
      const best = control.options
        .filter((m) => Object.hasOwn(anchors, m.id) && TIER_RANK[anchors[m.id]] <= max)
        .sort((a, b) => TIER_RANK[anchors[b.id]] - TIER_RANK[anchors[a.id]])[0];
      if (!best) throw unavailable('This agent has no mode that maps to that permission.');
      if (best.id !== control.current) {
        if (control.via === 'mode') await live.acpHost.setMode(ref(id).key, best.id);
        else await live.acpHost.setConfigOption(ref(id).key, control.configId, best.id);
      }
      return TIER_PERMISSION[anchors[best.id]];
    },
  };

  const FAST = {
    codex(id, enabled) {
      save(id, { serviceTier: enabled ? 'priority' : null });
    },
    async claude(id, enabled) {
      if (enabled) {
        const blocked = live.claudeTurns.fastBlocked ?? live.claudeTurns.probeInfo(live.claudeTurns.accountOf(id))?.fastBlocked;
        if (blocked) throw unavailable(`This session cannot serve fast mode: ${blocked}.`);
        const model = (await models.claude(id)).find((m) => m.id === SETTINGS.claude(id).model);
        if (model && !model.fast) throw unavailable(`${JSON.stringify(model.id)} does not offer fast mode.`);
      }
      save(id, { fast: enabled });
    },
  };

  const family = (id) => familyOf(ref(id).kind);
  const kindOf = (id) => ref(id).kind;
  const pendingOf = (id) => state(id)?.pendingSwitch ?? null;
  /** A setting saved now belongs to the harness the chat is leaving, and the switch would drop it. */
  const notWhileSwitching = (id) => {
    const pending = pendingOf(id);
    if (pending)
      throw coded(
        `This session moves to ${pending.harness} with its next message. Call set_session_harness again with the model and effort.`,
        'switch_pending',
      );
  };

  /** The target's model and effort for a switch, checked against what it offers; a basic harness keeps its own. */
  const targetSelection = async (id, kind, wanted) => {
    const listOf = models[parseKind(kind)?.family];
    if (!listOf) {
      if (wanted.model || wanted.effort) throw unavailable('This agent keeps its own model and effort until it has started.');
      return { model: '', effort: null };
    }
    // nothing to check against the target's list: it need not be running to be picked
    const list = wanted.model || wanted.effort || wanted.inheritedEffort ? await listOf(id) : [];
    if (wanted.model && !list.length) throw unavailable('The app has not reported that harness’s model list yet; try again in a moment.');
    const model = wanted.model
      ? pick(
          list.map((m) => m.id),
          wanted.model,
        )
      : configuredSwitchModel(kind, null, prefs());
    if (wanted.model && !model)
      throw coded(
        `Unknown model ${JSON.stringify(wanted.model)}. Available: ${list.map((m) => JSON.stringify(m.id)).join(', ')}.`,
        'unknown_model',
      );
    if (wanted.effort) offered(list, model, wanted.effort);
    // a level this session has but the model does not offer is not asked for: that model's default applies
    const inherited = list.find((m) => m.id === model)?.efforts?.includes(wanted.inheritedEffort) ? wanted.inheritedEffort : null;
    return { model, effort: wanted.effort ?? inherited };
  };
  const guard = (table, id, what) => {
    const fn = table[family(id)];
    if (!fn) throw unavailable(`${what} is not available for ${kindOf(id)}.`);
    return fn;
  };

  return {
    /** {kind, family, model, effort, permission, fast}, or null for a chat main does not know. */
    settingsOf(id) {
      let kind;
      try {
        kind = kindOf(id);
      } catch {
        return null;
      }
      return { kind, family: familyOf(kind), ...SETTINGS[familyOf(kind)](id) };
    },
    /** Whether a switch to this harness takes a model and effort; a basic agent keeps its own. */
    selectsModel(kind) {
      return !!models[parseKind(kind)?.family];
    },
    /** Refuses a setting for a chat a switch is waiting on: the tools ask before their cost checks, whose answer would mislead. */
    refuseWhileSwitching: notWhileSwitching,
    /** The switch the chat's next message settles, as get_session reports it, or null. */
    pendingSwitchOf(id) {
      const pending = pendingOf(id);
      return pending ? { harness: pending.harness, model: pending.model || null, effort: pending.effort ?? null } : null;
    },
    async setModel(id, model) {
      notWhileSwitching(id);
      return { model: await SET_MODEL[family(id)](id, model) };
    },
    async setEffort(id, effort) {
      notWhileSwitching(id);
      return { effort: await SET_EFFORT[family(id)](id, effort) };
    },
    /**
     * Record the harness the chat's next message moves it to: the pending switch the app's picker records, settled by
     * session/switch.cjs with the conversation carried across. The chat's own harness cancels a waiting one.
     * A switch already waiting for that harness keeps the handoff, account and goal chosen with it.
     * @param {string} id
     * @param {{ harness: string, model?: string | null, effort?: string | null, inheritedEffort?: string | null }} wanted
     *   inheritedEffort: this session's level, used only where the model offers it
     */
    async switchHarness(id, { harness, model = null, effort = null, inheritedEffort = null }) {
      const from = kindOf(id);
      if (harness === from) {
        if (pendingOf(id)) live.controller.state.patch(id, { pendingSwitch: null });
        return { harness, cancelled: true };
      }
      if (!parseKind(harness)) throw coded(`Unknown harness ${JSON.stringify(harness)}.`, 'unknown_harness');
      // a chat on another machine is that machine's agent: a switch left pending could later start a session on this Mac
      const host = live.hostOwnership?.get(id)?.hostId;
      if (host && host !== 'local') throw unavailable('This session runs on another machine. Continue it on this Mac to switch harness.');
      if (!(await usable(harness))) throw unavailable(`${harness} can’t take a session now.`);
      const selection = await targetSelection(id, harness, { model, effort, inheritedEffort });
      if (kindOf(id) !== from) throw coded('This session changed harness meanwhile. Try again.', 'harness_changed');
      // read after the wait: the user may have picked this switch meanwhile
      const waiting = pendingOf(id)?.harness === harness ? pendingOf(id) : null;
      const s = state(id);
      const next = model ? selection.model : (waiting?.model ?? selection.model);
      const level = selection.effort ?? waiting?.effort ?? null;
      live.controller.state.patch(id, {
        pendingSwitch: {
          // a goal the user paused stays paused; an agent's switch does not start it again
          ...(waiting ?? { mode: 'auto', goal: s?.goal?.status === 'active' ? s.goal.objective : null, multiAgent: false, account: null }),
          harness,
          model: next,
          modelLabel: next ? modelLabel(next) : '',
          effort: level,
        },
      });
      return { harness, model: next || null, effort: level, cancelled: false };
    },
    async setFast(id, enabled) {
      notWhileSwitching(id);
      await guard(FAST, id, 'Fast mode')(id, enabled);
      return enabled;
    },
    async setPermission(id, mode) {
      if (mode === 'plan' || state(id)?.plan)
        throw unavailable('Plan mode is switched from the chat’s composer; a session that is in plan mode is left by the user.');
      return { mode: await SET_PERMISSION[family(id)](id, mode) };
    },
  };
}

module.exports = { createSessionSettings, coded, familyOf };
