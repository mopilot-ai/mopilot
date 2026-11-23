// The Chrome side panel's model, effort, permission and harness menus (app/chromePanel.cjs): what each harness offers, the chat's or the next chat's current pick, a pick applied as the app's composer applies it, to the chat and as the default for new chats, and a chat's harness switched for its next message as the app's picker switches it.
const { parseKind } = require('../../shared/harnessKind.mjs');
const { modelLabel, effortLabel } = require('../../shared/modelLabels.mjs');
const { claudeModels, claudeDefaultModel } = require('../../shared/claudeModels.mjs');
const { chatModelChoice, effectiveModel } = require('../../shared/modelChoice.mjs');
const { permissionMenu, PERMISSION_ORDER, PERMISSION_LABEL } = require('../../shared/permissionMenu.mjs');
const { loginsOf } = require('./chromePanelShape.cjs');
const { chatAccountOf } = require('./chromePanelChatAccount.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { saveMeta } = require('../../shared/metaSave.mjs');
const { acpModeControl, selectValues, permissionOf } = require('../../shared/acpMode.mjs');
const { effectivePermission, PLAN_PERMISSION_HINT } = require('../../shared/effectivePermission.mjs');

/** @typedef {{ id: string, label: string, description: string | null, efforts: { id: string, label: string }[], defaultEffort: string | null, more: boolean, autoMode?: boolean }} PanelModel */
/** @typedef {{ id: string, label: string, detail: string, disabled?: string }} PanelPermission */

/** An ACP config option of a category as a select's values. */
const acpOption = (/** @type {any} */ acp, /** @type {string} */ category) =>
  (Array.isArray(acp?.configOptions) ? acp.configOptions : []).find(
    (/** @type {any} */ o) => o?.category === category && o.type === 'select',
  ) ?? null;

const efforts = (/** @type {string[]} */ ids) => ids.map((id) => ({ id, label: effortLabel(id) }));

/**
 * @param {object} d
 * @param {any} d.live main's late-bound services: chats, controller, codex, acpAdmission, acpHost, patchPrefs
 * @param {{ probeInfo: (account?: string) => any, probe: (bin: string, account?: string) => Promise<any>, findBinary: (bin?: string) => Promise<string | null> }} d.claude
 * @param {() => any} d.prefs the app's prefs
 * @param {(chatId: string) => string | null} d.kindOf the harness kind a chat runs on now
 * @param {(kind: string | null) => string | null} d.labelOf how the panel names a harness kind
 * @param {(kind: string) => Promise<boolean>} d.usable whether a harness can take a chat now
 * @param {(chatId: string) => boolean} [d.onMachine] whether a chat runs on a machine: a move it waits for is its Host's (chromePanelMachine.cjs), not a menu's
 */
function createPanelOptions({ live, claude, prefs, kindOf, labelOf, usable, onMachine = () => false }) {
  const pendingPicks = new Map();
  /** The switch a chat's next message settles (electron/session/switch.cjs), or null. */
  const pendingOf = (/** @type {string | undefined} */ chatId) =>
    chatId && !onMachine(chatId) ? (live.controller.state.get(chatId)?.pendingSwitch ?? null) : null;

  /**
   * The kind a menu is for: the harness a chat's next message switches to, else the chat's own, else the harness a new chat
   * will use. `chatId` is where its picks go: none while a switch waits, since the chat's session is still the old harness's
   * and the target starts on its defaults, as the app's picker does.
   */
  function kindFor(/** @type {{ harness?: string, chatId?: string }} */ p) {
    const pending = pendingOf(p.chatId);
    const id = pending?.harness ?? (p.chatId ? kindOf(p.chatId) : (p.harness ?? null));
    const kind = parseKind(id);
    if (!kind) throw new Error(p.chatId ? "That chat isn't in MoPilot." : 'Pick a harness.');
    const chatId = pending ? undefined : p.chatId;
    return { ...kind, id, chatId, permissionChatId: FAMILY[kind.family].sessionPermissions ? chatId : p.chatId, pending };
  }

  /** An open chat's login for its menu; a failed read costs that line, never the menu. */
  function ownAccount(/** @type {string} */ chatId, /** @type {string | null} */ kindId) {
    try {
      return chatAccountOf(live, chatId, kindId, live.capsService?.accountLabel(chatId) ?? null);
    } catch (error) {
      noteIgnored('read a chat login for its menu', error);
      return {};
    }
  }

  /** A basic harness's session state: the chat's open session, else the catalog with the defaults new chats start with. */
  function acpState(/** @type {string} */ basic, /** @type {string | undefined} */ chatId) {
    const own = chatId ? live.controller.state.get(chatId)?.acp : null;
    if (own) return own;
    const catalog = live.acpAdmission?.list().find((/** @type {any} */ h) => h.id === basic)?.catalog ?? {};
    const d = prefs().basicDefaults?.[basic] ?? {};
    const configOptions = (catalog.configOptions ?? []).map((/** @type {any} */ o) =>
      d.config && Object.hasOwn(d.config, o.id) ? { ...o, currentValue: d.config[o.id] } : o,
    );
    const modes = catalog.modes && d.mode ? { ...catalog.modes, currentModeId: d.mode } : catalog.modes;
    return { configOptions, modes };
  }

  /** The same native-mode-first permission projection as the app's composer. */
  const appPermission = {
    menu(/** @type {'codex' | 'claude'} */ family, /** @type {PanelModel | undefined} */ model, /** @type {string | undefined} */ chatId) {
      const menu = permissionMenu(family);
      /** @type {PanelPermission[]} */
      const rows = menu.rows.map((r) =>
        // as the app's menu: a model that can't auto-approve can't take "Approve for me"
        r.id === 'auto-review' && model?.autoMode === false ? { ...r, disabled: "This model can't auto-approve" } : r,
      );
      const value = effectivePermission(
        chatId ? live.chats.records.get(chatId)?.meta?.config : null,
        prefs().permission,
        chatId ? live.controller.state.get(chatId) : null,
      );
      if (value === 'plan') rows.unshift({ id: 'plan', label: 'Plan mode', detail: PLAN_PERMISSION_HINT, disabled: 'Plan mode is active' });
      return { title: 'What MoPilot can do', value, rows };
    },
    permit(/** @type {{ value: string, chatId?: string }} */ p) {
      if (!PERMISSION_ORDER.includes(/** @type {any} */ (p.value))) throw new Error("That permission isn't one MoPilot has.");
      if (p.chatId && live.chats.records.has(p.chatId)) {
        const config = live.chats.records.get(p.chatId)?.meta?.config ?? {};
        if (!saveMeta(live.chats, p.chatId, { config: { ...config, permission: p.value } }))
          throw new Error('The chat’s permissions could not be saved.');
      }
      live.patchPrefs({ permission: p.value });
    },
  };

  /** A basic harness's open session, for a chat that has one: where a pick goes besides the default. */
  const sessionKey = (/** @type {string | undefined} */ chatId) =>
    chatId && live.controller.state.get(chatId)?.acp ? live.controller.ref(chatId).key : null;

  /**
   * Each family's menus and how a pick is applied: its models and the pick now, its permission menu, a model and effort
   * picked (the chat's own and the default new chats start with, as the app's picker), and a permission picked.
   * @type {Record<string, { models: (chatId: string | undefined, basic: string) => Promise<{ models: PanelModel[], model: string | null, effort: string | null, recommendedModel?: string | null, automatic?: boolean }>,
   *   permissions: (chatId: string | undefined, basic: string, model: PanelModel | undefined) => { value: string | null } | null,
   *   selection: (chatId: string | undefined, basic: string) => unknown[],
   *   choose: (p: { chatId?: string, model: string | null, effort: string | null }, basic: string) => Promise<void>,
   *   permit: (p: { chatId?: string, value: string }, basic: string) => Promise<void>,
   *   ownModel?: boolean, sessionPermissions?: boolean }>} `ownModel`: the native session keeps its own model, so a switch to it names none
   */
  const FAMILY = {
    codex: {
      selection(chatId) {
        const config = live.chats.records.get(chatId)?.meta?.config;
        return [chatModelChoice(config, null, prefs().model ?? null), config?.effort ?? prefs().effort ?? null];
      },
      async models(chatId) {
        const p = prefs();
        const visible = Array.isArray(p.visibleEfforts) ? p.visibleEfforts : null;
        const list = (await live.codex.modelList())?.data ?? [];
        /** @type {PanelModel[]} */
        const models = list
          .filter((/** @type {any} */ m) => !m.hidden)
          .map((/** @type {any} */ m) => ({
            id: m.model,
            label: modelLabel(m.displayName),
            description: m.description ?? null,
            efforts: efforts(
              (m.supportedReasoningEfforts ?? [])
                .map((/** @type {any} */ e) => e.reasoningEffort)
                .filter((/** @type {string} */ e) => !visible || visible.includes(e)),
            ),
            defaultEffort: m.defaultReasoningEffort ?? null,
            more: false,
          }));
        // the chat's own where it set them, else the defaults (harness/codexParams.cjs chatPrefs)
        const config = chatId ? (live.chats.records.get(chatId)?.meta?.config ?? {}) : {};
        const selected = chatModelChoice(config, null, p.model);
        const recommendedModel = effectiveModel(null, list.find((/** @type {any} */ m) => m.isDefault)?.model, models[0]?.id);
        const model = effectiveModel(selected, recommendedModel);
        const picked = models.find((m) => m.id === model);
        return {
          models,
          model,
          recommendedModel,
          automatic: selected == null,
          effort: config.effort ?? p.effort ?? picked?.defaultEffort ?? null,
        };
      },
      permissions: (chatId, _basic, model) => appPermission.menu('codex', model, chatId),
      // the chat keeps them (its other settings stay); turns read them (harness/codexParams.cjs chatPrefs)
      async choose({ chatId, model, effort }) {
        live.patchPrefs({ model, effort });
        if (!chatId || !live.chats.records.has(chatId)) return;
        const config = live.chats.records.get(chatId)?.meta?.config ?? {};
        live.chats.patchMeta(chatId, { config: { ...config, model, effort } });
      },
      permit: async (p) => appPermission.permit(p),
    },
    claude: {
      selection(chatId) {
        const own = live.claudeTurns?.settings(chatId, {});
        return [
          own ? own.selectionModel : (prefs().claudeSelection?.model ?? null),
          own?.effort ?? prefs().claudeSelection?.effort ?? null,
        ];
      },
      async models(chatId) {
        const p = prefs();
        // the login's last probe; the first one runs here when no window has asked yet (no CLI: no models)
        let info = claude.probeInfo();
        if (!info) {
          const bin = await claude.findBinary(p.claudeBin ?? undefined);
          info = bin ? await claude.probe(bin) : null;
        }
        /** @type {PanelModel[]} */
        const models = claudeModels(info?.models ?? []).map((m) => ({
          id: m.id,
          label: m.label,
          description: m.description ?? null,
          efforts: efforts(m.efforts),
          defaultEffort: m.defaultEffort ?? null,
          more: !!m.more,
          autoMode: !!m.autoMode,
        }));
        // a chat's own pick where it has one (what its next turn runs on), else the defaults
        const sel = (chatId ? live.claudeTurns?.settings(chatId, {}) : null) ?? p.claudeSelection ?? {};
        const selected = 'selectionModel' in sel ? sel.selectionModel : sel.model;
        const recommendedModel = claudeDefaultModel(info?.models ?? []);
        const model = effectiveModel(selected, recommendedModel);
        const picked = models.find((m) => m.id === model);
        const effort = sel.effort && picked?.efforts.some((e) => e.id === sel.effort) ? sel.effort : (picked?.defaultEffort ?? null);
        return { models, model, recommendedModel, automatic: selected == null, effort };
      },
      permissions: (chatId, _basic, model) => appPermission.menu('claude', model, chatId),
      // the chat keeps it (on the login it runs on) and it goes with each message the panel sends (app/chromePanel.cjs typed)
      async choose({ chatId, model, effort }) {
        live.patchPrefs({ claudeSelection: { ...(prefs().claudeSelection ?? {}), model, effort } });
        if (!chatId) return;
        live.claudeTurns?.setOwn(chatId, { model, effort, account: live.claudeTurns.pickOf(chatId) });
        // saved with the chat too, so a restart or a window's push keeps it rather than the new-chat default
        if (live.chats.records.has(chatId))
          live.chats.patchMeta(chatId, { config: { ...(live.chats.records.get(chatId)?.meta?.config ?? {}), model, effort } });
      },
      permit: async (p) => appPermission.permit(p),
    },
    acp: {
      sessionPermissions: true,
      ownModel: true,
      selection(chatId, basic) {
        const state = acpState(basic, chatId);
        return [acpOption(state, 'model')?.currentValue ?? null, acpOption(state, 'thought_level')?.currentValue ?? null];
      },
      async models(chatId, basic) {
        const acp = acpState(basic, chatId);
        const m = acpOption(acp, 'model');
        const t = acpOption(acp, 'thought_level');
        const levels = selectValues(t).map((v) => ({ id: String(v.value), label: String(v.name ?? v.value) }));
        /** @type {PanelModel[]} */
        const models = selectValues(m).map((v) => ({
          id: String(v.value),
          label: String(v.name ?? v.value),
          description: v.description ?? null,
          efforts: levels,
          defaultEffort: null,
          more: false,
        }));
        return { models, model: m?.currentValue ?? null, effort: t?.currentValue ?? null };
      },
      // the session's modes; none: the harness decides by itself
      permissions(chatId, basic) {
        const control = acpModeControl(acpState(basic, chatId));
        if (!control) return null;
        const mapping = live.acpAdmission?.list().find((/** @type {any} */ h) => h.id === basic)?.permissionModes;
        /** @type {PanelPermission[]} */
        const rows = control.options.map((o) => {
          const p = permissionOf(mapping, o.id);
          return { id: o.id, label: p ? PERMISSION_LABEL[p] : o.name, detail: o.description ?? '' };
        });
        return { title: 'Mode', value: control.current, rows };
      },
      async choose({ chatId, model, effort }, basic) {
        const acp = acpState(basic, chatId);
        const sets = [
          [acpOption(acp, 'model')?.id, model],
          [acpOption(acp, 'thought_level')?.id, effort],
        ].filter(([id, value]) => id && value != null);
        const key = sessionKey(chatId);
        if (key) for (const [id, value] of sets) await live.acpHost.setConfigOption(key, id, value);
        const all = prefs().basicDefaults ?? {};
        const d = all[basic] ?? {};
        live.patchPrefs({ basicDefaults: { ...all, [basic]: { ...d, config: { ...d.config, ...Object.fromEntries(sets) } } } });
      },
      async permit({ chatId, value }, basic) {
        const control = acpModeControl(acpState(basic, chatId));
        if (!control?.options.some((o) => o.id === value)) throw new Error(`That mode isn't one this harness has.`);
        const key = sessionKey(chatId);
        if (key && control.via === 'config') await live.acpHost.setConfigOption(key, control.configId, value);
        else if (key) await live.acpHost.setMode(key, value);
        const all = prefs().basicDefaults ?? {};
        live.patchPrefs({ basicDefaults: { ...all, [basic]: { ...all[basic], mode: value } } });
      },
    },
  };

  /**
   * Why a chat can't move to `id` from its next message, in words safe to show, or null when it can: the harness must take
   * a chat now, and one that needs a model to start on (not a basic one: its session keeps its own) must have one.
   */
  async function switchBlocker(
    /** @type {string} */ id,
    /** @type {{ models?: Awaited<ReturnType<(typeof FAMILY)[keyof typeof FAMILY]['models']>> }} */ seen = {},
  ) {
    const kind = parseKind(id);
    if (!kind) return 'Pick a harness.';
    const label = labelOf(id) ?? id;
    if (!(await usable(id))) return `${label} can't take a chat now.`;
    const family = FAMILY[kind.family];
    if (family.ownModel) return null;
    // kept for the caller: a move reads the target's models once, for the check and for the model it starts on
    seen.models = await family.models(undefined, kind.basic ?? '');
    return seen.models.model ? null : `Pick a model for ${label} in MoPilot first.`;
  }

  return {
    switchBlocker,
    /** Opaque menu ownership: native session, account, a pending switch and the actual settings controls, never a display label. */
    owner(/** @type {string} */ chatId) {
      const kind = kindFor({ chatId });
      const meta = live.chats.records.get(chatId)?.meta;
      const native = live.controller.ref(chatId);
      const family = FAMILY[kind.family];
      return JSON.stringify([
        kind.id,
        native?.key ?? null,
        native?.instance ?? null,
        meta?.account?.id ?? null,
        kind.pending?.model ?? null,
        family.permissions(kind.permissionChatId, kind.basic ?? '', undefined)?.value ?? null,
        // while a switch waits, the target's defaults (the old harness's session is not this menu's)
        family.selection(kind.chatId, kind.basic ?? ''),
      ]);
    },
    /** The menus for a chat, or for a new chat on `harness`; `harnessId` is the kind they are for, `switching` while a switch waits. */
    async options(/** @type {{ harness?: string, chatId?: string }} */ p) {
      const kind = kindFor(p);
      const family = FAMILY[kind.family];
      const now = await family.models(kind.chatId, kind.basic ?? '');
      // a pending switch runs on the model chosen for it (none on a basic harness: its session keeps its own)
      const pending = kind.pending && !family.ownModel ? kind.pending : null;
      const automatic = pending?.model === null ? true : pending?.model ? false : now.automatic;
      const model = pending ? effectiveModel(pending.model || null, automatic ? now.recommendedModel : now.model) : now.model;
      const picked = now.models.find((m) => m.id === model);
      // a new chat may pick its login where there is more than one to pick from; signed-out ones are listed, marked, never dropped
      const logins = p.chatId ? [] : loginsOf(live, kind.family);
      // an open chat reports its own login, unless a switch waits (the target agent's login is a new chat's choice then)
      const own = p.chatId && !kind.pending ? ownAccount(p.chatId, kind.id) : {};
      return {
        ...now,
        ...(logins.length > 1 && { accounts: logins }),
        ...own,
        model,
        automatic,
        nativeModel: !!family.ownModel,
        harness: labelOf(kind.id),
        harnessId: kind.id,
        switching: !!kind.pending,
        permission: family.permissions(kind.permissionChatId, kind.basic ?? '', picked),
      };
    },
    /** A model and effort picked: while a switch waits, the target's defaults and the model the switch goes on. */
    async choose(/** @type {{ harness?: string, chatId?: string, model: string | null, effort: string | null }} */ p) {
      const kind = kindFor(p);
      const family = FAMILY[kind.family];
      const attempt = Symbol();
      if (kind.pending && p.chatId) pendingPicks.set(p.chatId, attempt);
      try {
        await family.choose({ ...p, chatId: kind.chatId }, kind.basic ?? '');
        if (!kind.pending || family.ownModel || !p.chatId) return;
        const options = await family.models(undefined, kind.basic ?? '');
        const label = options.models.find((m) => m.id === (p.model ?? options.recommendedModel))?.label ?? p.model ?? 'Automatic';
        // The latest pick owns only the exact switch it was made for, including a same-harness replacement.
        const now = pendingOf(p.chatId);
        if (now === kind.pending && pendingPicks.get(p.chatId) === attempt)
          live.controller.state.patch(p.chatId, { pendingSwitch: { ...now, model: p.model, modelLabel: label, effort: p.effort ?? null } });
      } finally {
        if (pendingPicks.get(p.chatId) === attempt) pendingPicks.delete(p.chatId);
      }
    },
    /** A permission (or a basic harness's mode) picked. */
    async permit(/** @type {{ harness?: string, chatId?: string, value: string }} */ p) {
      const kind = kindFor(p);
      await FAMILY[kind.family].permit({ ...p, chatId: kind.permissionChatId }, kind.basic ?? '');
    },
    /**
     * A chat's harness picked: its next message moves the chat there (the same pending switch the app's picker records, with
     * the conversation carried automatically and an unfinished goal set again); its own harness again cancels a waiting one.
     */
    async switchTo(/** @type {{ chatId: string, harness: string, account?: string | null }} */ p) {
      const state = live.controller.state;
      const from = kindOf(p.chatId);
      if (p.harness === from) {
        if (pendingOf(p.chatId)) state.patch(p.chatId, { pendingSwitch: null });
        return;
      }
      const waiting = pendingOf(p.chatId)?.harness === p.harness ? pendingOf(p.chatId) : null;
      // the switch already waiting for it stays as it is, with the model picked for it; only a login picked now is put on it
      if (waiting && p.account === undefined) return;
      const kind = parseKind(p.harness);
      if (!kind) throw new Error('Pick a harness.');
      const label = labelOf(p.harness) ?? p.harness;
      // a chat main can't place on a harness has nothing to carry over
      if (!parseKind(from)) throw new Error(`This chat can't move to ${label}. Start a new chat on it.`);
      // only a harness the panel lists (admitted, signed in) with a model to start on; one that still can't take the chat is refused by the switch itself
      const seen = {};
      const blocker = await switchBlocker(p.harness, seen);
      if (blocker) throw new Error(blocker);
      // a login picked with the move is one of the target agent's, held per chat there, the way a new chat's is
      if (typeof p.account === 'string') {
        if (!loginsOf(live, kind.family).some((a) => a.id === p.account && a.loggedIn))
          throw new Error("That account isn't available for this agent.");
        if (!live.identity?.driver(kind.family)?.perChat) throw new Error(`${label} can't put a chat on its own account now.`);
      }
      const picked = p.account === undefined ? {} : { account: p.account, automaticAccount: p.account === null };
      if (waiting) {
        state.patch(p.chatId, { pendingSwitch: { ...waiting, ...picked } });
        return;
      }
      const family = FAMILY[kind.family];
      // a basic harness keeps its own model: nothing of its list is used
      const { models, model } = seen.models ?? { models: [], model: null };
      const basic = !!family.ownModel;
      // the chat moved while the harness was read: this pick was for the harness it was on
      if (kindOf(p.chatId) !== from) throw new Error('This chat changed harness meanwhile. Pick again.');
      const s = state.get(p.chatId);
      const goal = s?.goal && s.goal.status !== 'complete' ? s.goal.objective : null;
      state.patch(p.chatId, {
        pendingSwitch: {
          harness: p.harness,
          model: basic ? '' : family.selection(undefined, kind.basic ?? '')[0],
          modelLabel: basic ? '' : (models.find((m) => m.id === model)?.label ?? model),
          mode: 'auto',
          goal,
          multiAgent: false,
          account: null,
          ...picked,
        },
      });
    },
  };
}

module.exports = { createPanelOptions };
