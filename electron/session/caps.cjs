// What a chat can do right now (design principles[3]): the chat's current segment says which harness
// adapter answers, and its bindings go through shared/caps.mjs with the provider, model, account,
// flags and session state the chat has. Windows ask here (`session:caps`) and only draw the result.
const { SEMANTICS, resolveCaps, present } = require('../../shared/caps.mjs');
const { gatewayEntry, gatewayDrops } = require('../../shared/mopilotCaps.mjs');
const { harnessOff, channelKey } = require('../../shared/killSwitch.cjs');
const { claudeProbes } = require('../harness/versions.cjs');
const { codexBindings, claudeBindings, acpBindings, machineBindings, PROBES_FOR } = require('../harness/bindings.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { chatModelChoice, effectiveModel } = require('../../shared/modelChoice.mjs');
const { claudeDefaultModel } = require('../../shared/claudeModels.mjs');
const { momoModelOf } = require('../../shared/momoChat.mjs');

/** Remote kill switches (electron/platform/flags.cjs) as the semantics they turn off. */
const KILLS = {
  computerUse: ['shared.computerUse.enabled'],
  browser: ['shared.browser.panelCdp', 'shared.browser.extension'],
  dictation: ['shared.dictation.enabled'],
  design: ['shared.design.enabled'],
  artifacts: ['native.claude.artifacts'],
};
/** `flags` keys for the flag gate: `sage.<semantic>` false when its switches are all off, `sage.harness` / `sage.channel` for the chat's harness and its tool channel, the harness's own `features.<name>` (Codex's negotiation). */
function flagsFor(isEnabled, harnessFlags, kind) {
  const out = {};
  for (const [semantic, keys] of Object.entries(KILLS)) if (keys.every((k) => !isEnabled(k))) out[`sage.${semantic}`] = false;
  // the chat's harness switched off, or the channel that carries MoPilot's tools to it
  if (kind && harnessOff(kind, isEnabled)) out['sage.harness'] = false;
  const channel = channelKey(kind);
  if (channel && !isEnabled(channel)) out['sage.channel'] = false;
  // MoPilot's plugins on this family (electron/plugins/delivery.cjs)
  const family = parseKind(kind)?.family;
  if (family && !isEnabled(`plugins.${family}`)) out['sage.plugins'] = false;
  for (const [k, v] of Object.entries(harnessFlags ?? {})) if (typeof v === 'boolean') out[k] = v;
  return out;
}

/**
 * A Codex model/list entry as ModelInfo. serviceTiers: every tier the model reports ("priority" is Fast).
 * @returns {import('../../shared/model/harness').ModelInfo | null}
 */
function codexModelInfo(m) {
  if (!m) return null;
  const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? e);
  return {
    id: m.model ?? m.id,
    label: m.displayName ?? m.model,
    input: m.inputModalities ?? 'unknown',
    efforts,
    ultra: efforts.includes('ultra'),
    serviceTiers: (m.serviceTiers ?? []).map((t) => t.id).filter((id) => id && id !== 'default'),
  };
}

/**
 * A Claude model from the CLI's init (supportedEffortLevels, supportsFastMode) as ModelInfo.
 * @returns {import('../../shared/model/harness').ModelInfo | null}
 */
function claudeModelInfo(m, getSettings) {
  if (!m) return null;
  return {
    id: m.value,
    label: m.displayName ?? m.value,
    input: 'unknown',
    efforts: m.supportedEffortLevels ?? [],
    // ultracode: a session setting, available where getSettings says so (or until a session says otherwise)
    ultra: getSettings?.available !== false,
    serviceTiers: m.supportsFastMode ? ['priority'] : [],
  };
}

/** The provider an instance runs on, with what the endpoint can't serve. `modelCaps`: MoPilot's gateway table by model. */
function providerProfile(inst, model, modelCaps) {
  const p = inst?.provider ?? null;
  if (!p) return null;
  const drops = [];
  if (p.id === 'mopilot') {
    // what the gateway table says it can't serve for this model, by semantic name (both harnesses)
    drops.push(...gatewayDrops(modelCaps, model?.id, inst.harness));
  } else if (!p.firstParty) drops.push('speed');
  return {
    id: p.id,
    wires: p.wires ?? [],
    baseUrl: p.baseUrl ?? '',
    firstParty: !!p.firstParty,
    models: [],
    drops,
    visionFallbackModel: p.visionFallbackModel ?? null,
  };
}

/**
 * What main declares of each first-tier harness's negotiation; what its session answered (version, probes) fills in the
 * rest (negotiated()).
 * @type {Record<'codex' | 'claude', { pdf: boolean, humanOrigin: boolean, slashLastBlockOnly: boolean, fork: string, ephemeral: string, perTaskStop: boolean, toolInjection: string, tasks: string, failover: string, perChat: boolean, ext: Record<string, boolean> }>}
 */
const DECLARED = {
  codex: {
    pdf: false,
    humanOrigin: false,
    slashLastBlockOnly: false,
    fork: 'whole',
    ephemeral: 'native',
    perTaskStop: false,
    toolInjection: 'threadConfigMcp',
    tasks: 'cancelAll',
    failover: 'inRequest',
    perChat: false,
    ext: { realtimeVoice: true, cloudTasks: true, feedbackUpload: true },
  },
  claude: {
    pdf: true,
    humanOrigin: true,
    slashLastBlockOnly: true,
    fork: 'upToTurn',
    ephemeral: 'none',
    perTaskStop: true,
    toolInjection: 'sdkMcp',
    tasks: 'stoppable',
    failover: 'restartResume',
    perChat: true,
    ext: { outputStyle: true },
  },
};

/** A first-tier harness's negotiation as far as main knows it: what it declares, the CLI version and the probes a live session has answered. */
function firstTierNegotiated(d, o) {
  return {
    cliVersion: o.version ?? '',
    versionStatus: o.status ?? 'ok',
    probes: o.probes ?? {},
    prompt: { image: ['image/png', 'image/jpeg'], pdf: d.pdf, humanOrigin: d.humanOrigin, slashLastBlockOnly: d.slashLastBlockOnly },
    session: {
      load: true,
      resume: true,
      fork: d.fork,
      rewind: true,
      ephemeral: d.ephemeral,
      perTaskStop: d.perTaskStop,
      history: 'native',
    },
    permissions: { scope: 'turn', remember: 'none' },
    approvals: ['command', 'fileChange', 'permissions', 'question', 'plan'],
    toolInjection: d.toolInjection,
    events: { turnEnd: true, usage: 'tokens', tasks: d.tasks },
    accounts: { failover: d.failover, perChat: d.perChat, usage: 'polled' },
    ext: { ...d.ext },
  };
}

/** What main knows of a basic harness's session: its account lane comes from the ACP identity driver. */
function acpNegotiated(o) {
  return { cliVersion: o.version ?? '', versionStatus: 'ok', probes: {}, accounts: o.accounts };
}

/**
 * @typedef {object} Read what a family's harness says about a chat, read for its capabilities
 * @property {import('../../shared/model/harness').ModelInfo | null} model
 * @property {any} negotiated the negotiation as main knows it (a basic harness's has only its version and account lane)
 * @property {Record<string, unknown>} harnessFlags the harness's own `features.<name>` (Codex's negotiation)
 * @property {any} inst the identity instance the chat runs on (o.instances), or null
 * @property {string | null} fastBlocked a FAST_BLOCKED_TEXT key
 * @property {Record<string, unknown>} accountExtra what the family adds to the chat's account layer (when it has an instance)
 * @property {Record<string, unknown>} [sessionExtra] what the family adds to the chat's session layer (its live process)
 * @property {any} acp a basic harness's session (modes, config options) and plan, or null
 */

/**
 * The account instance a chat's turns run on: Codex's relay pin for the chat's thread, else the active account; Claude's
 * own pick (ClaudeAdapter.pickedLogin), else the active login. The saved meta.account is Claude's.
 */
/** What a Codex login that is a signed-in ChatGPT subscription is allowed (voice chat, Remote Control), as the account gate reads it. */
function chatgptFacts(inst, o) {
  const ok = inst.billing === 'subscription' && inst.status === 'ok' && (!o.codexAuth || o.codexAuth() === 'chatgpt');
  return { voiceChat: ok, remoteControlChatGPT: ok, nativeDictation: ok, dictationAccount: 'chatgpt' };
}

const ACCOUNT_OF = {
  codex: (o, key) => o.chatInstance?.('codex', key ?? null) || o.instances('codex').find((x) => x.active) || null,
  claude: (o, accountId) => {
    const instances = o.instances('claude');
    return (accountId && instances.find((x) => x.account === accountId)) || instances.find((x) => x.active) || null;
  },
};
/**
 * What the app's account rows count as a login a person tells apart, by harness family: not the key setting or MoPilot credits that
 * sit beside Claude Code's logins, and not a login signed out with nothing known of it; and whether a chat names a login of its own
 * (Codex only when it is pinned to one, as in src/session/harness/chatAccount.ts).
 */
const CHIP = {
  codex: { login: (i) => i.kind !== 'sageKey' || i.billing !== 'credits', own: (o, ref) => !!o.chatInstance?.('codex', ref.key) },
  claude: { login: (i) => i.kind !== 'sageKey', own: () => true },
};
const knownLogin = (i) => i.status !== 'signedOut' || !!i.label || i.active === true;

/** The account instance a chat runs on, by its harness family (CapsService.accountLabel); a basic harness has none. */
const CHAT_ACCOUNT = {
  codex: (o, _chatId, ref) => ACCOUNT_OF.codex(o, ref.key),
  claude: (o, chatId) => ACCOUNT_OF.claude(o, o.claudeLogin?.(chatId) || null),
};

/**
 * Each family's part of a chat's capabilities, as data: its tier, the bindings its adapter declares, the probes that
 * gate them, whether a chat has its own account, its negotiation as main knows it, and how its model, account and
 * identity instance are read. This table is where the harnesses' capability differences live; nothing else in this
 * module tells them apart.
 * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, {
 *   tier: 'first' | 'basic',
 *   bindings: (i: any) => ReturnType<typeof codexBindings>,
 *   probes: Record<string, string[]>,
 *   perChat: boolean,
 *   negotiated: (o: any) => any,
 *   read: (o: any, c: { kind: string, ref: any, rec: any, seg: any, hint: any, prefs: any, accountId: string | null, session: any, opened: { acp?: any } | null }) => Promise<Read>,
 * }>}
 */
const FAMILY_CAPS = {
  codex: {
    tier: 'first',
    bindings: (i) => codexBindings(i.negotiated),
    probes: PROBES_FOR.codex,
    perChat: DECLARED.codex.perChat,
    negotiated: (o) => firstTierNegotiated(DECLARED.codex, o),
    read: async (o, c) => {
      // unanswered reads like an app-server that is not up yet: the capabilities say what is not known
      const info = await o.codex().catch((error) => (noteIgnored('read the Codex models and negotiation', error), null));
      const selected = c.hint.model !== undefined ? c.hint.model : chatModelChoice(c.rec?.meta?.config, null, c.prefs.model);
      const pick = effectiveModel(selected, info?.models?.find((m) => m.isDefault)?.model);
      const inst = ACCOUNT_OF.codex(o, c.ref?.key);
      return {
        model: codexModelInfo(info?.models?.find((m) => m.model === pick)),
        negotiated: FAMILY_CAPS.codex.negotiated({
          version: info?.version ?? null,
          probes: info?.negotiated?.probes,
          status: info?.negotiated?.versionStatus,
        }),
        harnessFlags: info?.negotiated?.flags ?? {},
        inst,
        fastBlocked: null,
        accountExtra: inst ? chatgptFacts(inst, o) : {},
        acp: null,
      };
    },
  },
  claude: {
    tier: 'first',
    bindings: () => claudeBindings(),
    probes: PROBES_FOR.claude,
    perChat: DECLARED.claude.perChat,
    negotiated: (o) => firstTierNegotiated(DECLARED.claude, o),
    read: async (o, c) => {
      const inst = ACCOUNT_OF.claude(o, c.accountId);
      const probe = o.claude.probeInfo(inst?.kind === 'sageKey' ? undefined : inst?.account);
      const applied = c.ref?.key ? o.claude.appliedOf(c.ref.key) : null;
      const models = probe?.models ?? [];
      const saved = c.rec?.meta?.config;
      // Imported Claude sessions without saved intent retain their native pick; a durable Automatic choice overrides it.
      const nativeModel = saved?.model === undefined ? c.seg?.model : null;
      const selected = c.hint.model !== undefined ? c.hint.model : chatModelChoice(saved, nativeModel, c.prefs.claudeSelection?.model);
      const pick = momoModelOf(c.rec?.meta) ?? effectiveModel(selected, claudeDefaultModel(models));
      const base = String(pick).replace(/\[.*\]$/, '');
      // the Artifact tool: the user's switch, the live process's init tools and whether the login is claude.ai's
      const art = o.claude.artifactsOf?.(c.ref?.key ?? null, inst?.kind === 'sageKey' ? undefined : inst?.account) ?? null;
      return {
        model: claudeModelInfo(models.find((m) => m.value === pick) ?? models.find((m) => m.value === base) ?? null, applied),
        negotiated: FAMILY_CAPS.claude.negotiated({ version: o.claude.version(), probes: claudeProbes(applied) }),
        harnessFlags: art?.on === false ? { 'user.artifacts': false } : {},
        inst,
        fastBlocked: probe?.fastBlocked ?? null,
        accountExtra: art ? { artifacts: art.claudeAi, remoteControl: art.claudeAi } : {},
        sessionExtra: typeof art?.tool === 'boolean' ? { artifacts: art.tool, artifactsStale: !!art.stale } : {},
        acp: null,
      };
    },
  },
  acp: {
    tier: 'basic',
    bindings: (i) => acpBindings(i.acp, i.kind),
    probes: {},
    perChat: false,
    negotiated: (o) => acpNegotiated(o),
    read: async (o, c, q = o.acpQuirks?.(c.kind)) => ({
      model: null,
      negotiated: acpNegotiated({ accounts: o.accounts?.('acp') ?? { failover: 'none', perChat: false, usage: 'none' } }),
      harnessFlags: {},
      inst: null,
      fastBlocked: null,
      accountExtra: {},
      // a chat as it opens (c.opened): the catalog its harness's admission check saw stands in for the session
      acp: {
        ...(c.session?.acp ?? c.opened?.acp ?? {}),
        plan: q?.plan ?? null,
        agentModes: q?.agentModes ?? null,
      },
    }),
  },
};

/** A kind's entry of FAMILY_CAPS ('codex', 'claude', 'acp:<id>'), or null for a kind this build doesn't know. */
function familyCaps(kind) {
  const family = parseKind(kind)?.family;
  return family ? FAMILY_CAPS[family] : null;
}

/**
 * Negotiated, as far as main knows it, for a harness kind: a first-tier harness's declarations with its CLI version and
 * the probes a live session has answered; a basic harness's version and account lane.
 */
function negotiated(kind, o) {
  const fam = familyCaps(kind);
  if (!fam) throw new Error(`Unknown harness kind: ${JSON.stringify(kind)}`);
  return fam.negotiated(o);
}

/** One semantic as a window needs it. */
function view(b) {
  const state = present(b, { scope: 'context' });
  const out = { state, via: b.via };
  if (b.via === 'none') {
    out.why = b.why;
    if (b.why.fix) out.fix = b.why.fix;
  }
  if (b.via === 'passthrough') out.template = b.template;
  if (b.via === 'route') out.to = b.to;
  if (b.via === 'polyfill') out.engine = b.engine;
  // a harness's own speech service (nativeDictation): the engine main's dictation uses for it
  if (b.via === 'config' && b.option === 'speechEngine') out.engine = b.value;
  return out;
}

/**
 * The pure part: everything the layers need, already gathered. Returns { semantic: {state, via, why?, fix?} }.
 * @param {Omit<import('../../shared/caps.mjs').CapsInput, 'tier' | 'bindings' | 'probesFor'> & { kind: string, acp?: Parameters<typeof acpBindings>[0], agent?: unknown }} i
 *   kind: 'codex' | 'claude' | 'acp:<id>'; acp: a basic harness's session (modes, config options) and plan; agent: the Host's agent of a chat on a machine
 */
function computeCaps(i) {
  const fam = familyCaps(i.kind);
  if (!fam) throw new Error(`Unknown harness kind: ${JSON.stringify(i.kind)}`);
  // a probe counts only once a session has answered it; before that the capability stands as declared
  const probesFor = {};
  for (const [s, probes] of Object.entries(fam.probes))
    if (probes.every((p) => i.negotiated && p in i.negotiated.probes)) probesFor[s] = probes;
  const caps = resolveCaps({
    tier: fam.tier,
    bindings: machineBindings(fam.bindings(i), i.agent),
    negotiated: i.negotiated,
    probesFor,
    provider: i.provider,
    model: i.model,
    account: i.account,
    flags: i.flags,
    session: i.session,
    temporary: !!i.temporary,
  });
  const out = {};
  for (const s of SEMANTICS) out[s] = view(caps[s]);
  return out;
}

class CapsService {
  /**
   * @param {object} o
   * @param {(chatId: string) => { kind: string, key: string, instance: string|null } | null} o.ref the chat's current segment
   * @param {(chatId: string) => { meta: any, segments: any[] }} o.record
   * @param {(chatId: string) => any} o.session SessionStore.get
   * @param {(key: string) => boolean} o.isEnabled a remote kill switch (electron/platform/flags.cjs)
   * @param {() => Promise<{ version: string|null, models: any[], negotiated: any } | null>} o.codex the app-server's answers (CodexAdapter.info)
   * @param {{ version: () => string|null, probeInfo: (account?: string) => any, appliedOf: (key: string) => any,
   *   artifactsOf?: (key: string|null, account?: string) => { on: boolean, tool: boolean|null, stale?: boolean, claudeAi: boolean } }} o.claude
   * @param {(chatId: string) => string | null} [o.claudeLogin] the login a Claude chat with a pick of its own runs on
   * @param {(harness: string) => any[]} o.instances identity instances of a harness
   * @param {(harness: string, key: string|null) => any} [o.chatInstance] the live account lane, including relay pins
   * @param {() => string|null} [o.codexAuth] the shared app-server's current authentication kind
   * @param {(harness: string) => { failover: string, perChat: boolean, usage: string } | null} [o.accounts] a harness's account lane (its identity driver's `lane`)
   * @param {() => Promise<Record<string, {fast: boolean}> | null>} [o.modelCaps] MoPilot's gateway table
   * @param {() => any} o.prefs ui prefs: model, claudeSelection
   * @param {(chatId: string) => boolean} [o.onMachine] the chat runs on another machine: its sends take the Host's path (remotePicks.cjs)
   * @param {(kind: string) => ({ plan?: { mode?: string, configOption?: string } | null, agentModes?: string[] | null } | null)} [o.acpQuirks]
   *   a basic harness's quirks as described: its plan marker and the agent's own modes
   */
  constructor(o) {
    this.o = o;
  }

  /**
   * The account a chat's turns run on now, as its instance names it (an email, "API key", "MoPilot credits"), or null
   * (a basic harness, or none known).
   * @param {string} chatId
   * @returns {string | null}
   */
  accountLabel(chatId) {
    const o = this.o;
    const ref = o.ref(chatId);
    const family = parseKind(ref?.kind)?.family;
    return (family && CHAT_ACCOUNT[family]?.(o, chatId, ref)?.label) ?? null;
  }

  /**
   * The account chip of a chat in a list (a phone's chat list and header): the account's label, only where its harness has
   * several accounts to tell apart; a harness with one (or none, a basic one) has nothing to say.
   * @param {string} chatId
   * @returns {string | null}
   */
  accountChip(chatId) {
    const ref = this.o.ref(chatId);
    const family = parseKind(ref?.kind)?.family;
    const rule = family && CHIP[family];
    if (!rule || this.o.instances(family).filter((i) => rule.login(i) && knownLogin(i)).length < 2 || !rule.own(this.o, ref)) return null;
    return this.accountLabel(chatId);
  }

  /** Whether the login a chat runs on is the computer's default (the active one, not one it picked), which a list leaves unsaid; false with no account to name. @param {string} chatId */
  accountIsDefault(chatId) {
    const ref = this.o.ref(chatId);
    return CHAT_ACCOUNT[parseKind(ref?.kind)?.family]?.(this.o, chatId, ref)?.active === true;
  }

  /** An actual exhausted account, scoped to this chat's current login; no estimated quota for an unknown provider. */
  accountLimit(chatId) {
    const ref = this.o.ref(chatId);
    const family = parseKind(ref?.kind)?.family;
    const account = family && CHAT_ACCOUNT[family]?.(this.o, chatId, ref);
    return account?.limited ? { key: account.id, text: `Usage limit reached on ${account.label}.` } : null;
  }

  /**
   * @param {string|null} chatId the chat, or null for a new chat that hasn't started
   * @param {{ kind?: string, model?: string|null, temporary?: boolean, elsewhere?: boolean }} [hint] what the window knows and main
   *   doesn't yet: the harness a new chat will use, the chat's own model before it is sent, a temporary chat, another app running it
   * @param {{ acp?: any } | null} [opened] a new chat as it will be once its session opens (a harness's Settings page,
   *   harnessCaps.cjs): `acp`, the catalog a basic harness's admission check saw, stands in for its session
   * @returns {Promise<{ kind: string, tier: 'first'|'basic', provider: { id: string, label: string, firstParty: boolean, visionFallbackModel?: string | null } | null, caps: Record<string, any> } | null>}
   */
  async get(chatId, hint = {}, opened = null) {
    const o = this.o;
    const ref = chatId ? o.ref(chatId) : null;
    const kind = ref?.kind ?? hint.kind;
    if (!kind) return null;
    // a harness this build doesn't know: nothing to say about it
    const fam = familyCaps(kind);
    if (!fam) return null;
    const rec = chatId ? o.record(chatId) : null;
    const seg = rec?.segments?.[rec.segments.length - 1] ?? null;
    const session = chatId ? o.session(chatId) : null;
    const prefs = o.prefs() ?? {};
    // the login a Claude chat's turns run on, when it has a pick of its own (ClaudeAdapter.pickedLogin)
    const accountId = (chatId && o.claudeLogin?.(chatId)) || null;
    const read = await fam.read(o, { kind, ref, rec, seg, hint, prefs, accountId, session, opened: chatId ? null : opened });
    const inst = read.inst;
    const modelCaps =
      inst?.provider?.id === 'mopilot' && o.modelCaps
        ? await o.modelCaps().catch((error) => (noteIgnored("read MoPilot's model table", error), null))
        : null;
    const provider = providerProfile(inst, read.model, modelCaps);
    const account = inst
      ? { billing: inst.billing, perChat: fam.perChat, fast: !read.fastBlocked, fastBlocked: read.fastBlocked, ...read.accountExtra }
      : null;

    const caps = computeCaps({
      kind,
      agent: chatId && o.onMachine?.(chatId) ? (rec?.meta?.config?.hostAgent ?? kind) : undefined,
      negotiated: read.negotiated,
      acp: read.acp,
      provider,
      model: read.model,
      account,
      flags: flagsFor(o.isEnabled ?? (() => true), read.harnessFlags, kind),
      // main's own reconcile marks a turn another app runs (reconcile.cjs); a window may know it first
      session: session
        ? { turn: session.turn, runningElsewhere: !!session.runningElsewhere || !!hint.elsewhere, ...read.sessionExtra }
        : hint.elsewhere
          ? { turn: 'idle', runningElsewhere: true, ...read.sessionExtra }
          : null,
      temporary: !!hint.temporary,
    });
    return {
      kind,
      tier: fam.tier,
      provider: inst?.provider
        ? {
            id: inst.provider.id,
            label: inst.provider.label ?? inst.provider.id,
            firstParty: !!inst.provider.firstParty,
            visionFallbackModel: inst.provider.visionFallbackModel ?? null,
          }
        : null,
      caps,
    };
  }
}

module.exports = {
  CapsService,
  computeCaps,
  flagsFor,
  codexModelInfo,
  claudeModelInfo,
  providerProfile,
  gatewayEntry,
  negotiated,
  acpNegotiated,
  view,
};
