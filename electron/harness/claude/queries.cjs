// Bounded Claude Code queries beside a chat's own session: the model probe, plan usage, the user's extras, a summary note and a chat title.
const { helperReply } = require('./helperReply.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const { readUsage } = require('./usage.cjs');
const { titlePrompt } = require('../../../shared/title.mjs');
const { unrefTimer, sdkBin } = require('./cli.cjs');
const { noChrome } = require('./sessionOptions.cjs');
const { slashCommand } = require('./catalog.cjs');
const { noteIgnored, messageOf } = require('../../ignored.cjs');
const { loginEmail } = require('./loginIdentity.cjs');
const { confineHelperOptions } = require('./helperIsolation.cjs');
const { denyManaged } = require('./gatewayNative.cjs');
const { createTitleHelper } = require('./titleHelper.cjs');

/** Keep only connection capabilities; URLs, headers and credentials never cross the settings bridge. */
function mcpSettingsRows(data) {
  if (!Array.isArray(data)) throw new Error('Claude Code returned an invalid MCP server list');
  const names = new Set();
  return data.map((m) => {
    if (!m || typeof m.name !== 'string' || !m.name || typeof m.status !== 'string' || names.has(m.name))
      throw new Error('Claude Code returned an invalid MCP server');
    for (const field of ['source', 'scope'])
      if (m[field] !== undefined && typeof m[field] !== 'string') throw new Error('Claude Code returned invalid MCP provenance');
    names.add(m.name);
    return {
      name: m.name,
      status: m.status,
      ...(m.source !== undefined ? { source: m.source } : {}),
      ...(m.scope !== undefined ? { scope: m.scope } : {}),
      ...(typeof m.config?.type === 'string' ? { transport: m.config.type } : {}),
    };
  });
}

/**
 * The models the gateway serves over the Anthropic wire that the CLI's own list lacks (DeepSeek's), as the CLI
 * would list them. Only what the capability table names: a model absent from it is not offered. Claude's own
 * ids stay the CLI's aliases (opus, sonnet, haiku).
 */
function withGatewayModels(models, caps) {
  const have = new Set(models.map((m) => m.value));
  const extra = [];
  for (const [id, c] of Object.entries(caps ?? {})) {
    if (have.has(id) || /^claude/.test(id) || !(c?.wires ?? []).includes('anthropic')) continue;
    extra.push({
      value: id,
      displayName: id,
      description: 'Served by MoPilot credits',
      supportsEffort: !!c.efforts?.length,
      supportedEffortLevels: c.efforts ?? [],
      supportsFastMode: false,
      supportsAutoMode: false,
    });
  }
  return extra.length ? [...models, ...extra] : models;
}

/**
 * The models a routed config (Your own provider, electron/routing) answers with that the CLI's own list lacks: its model
 * and its tier models, first, as the CLI would list them. Claude's own aliases stay: the router answers each with the
 * config's tier model for that family, or its model.
 * @param {any[]} models @param {import('./state.cjs').RoutedConfig | null | undefined} config
 */
function withRoutedModels(models, config) {
  if (!config) return models;
  const have = new Set(models.map((m) => m.value));
  const ids = [...new Set([config.model, ...Object.values(config.tierModels)])].filter((id) => typeof id === 'string' && !have.has(id));
  const own = ids.map((id) => ({
    value: id,
    displayName: id,
    description: `Served by ${config.name}`,
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsFastMode: false,
    supportsAutoMode: false,
  }));
  return own.length ? [...own, ...models] : models;
}

// Reasons fast mode can't be used at all (others, like 'preference', only mean it isn't switched on).
const FAST_BLOCKERS = new Set(['extra_usage_disabled', 'free', 'not_first_party', 'disabled_by_env']);

/**
 * @param {import('./state.cjs').ClaudeState} state
 * @param {{ auth: ReturnType<typeof import('./auth.cjs').createAuth>, cli: ReturnType<typeof import('./cli.cjs').createCli> }} deps
 */
function createQueries(state, { auth, cli }) {
  /** What the last probe of each login reported (models, fast-mode blocker), for the capability resolver. */
  const probed = new Map();
  /** The last probe for a login (null before any). */
  const probeInfo = (account) => probed.get(account ?? 'default') ?? probed.get('default') ?? null;

  /** Ask the CLI for its models, account and fast-mode availability without sending a prompt (no tokens used). */
  async function probe(bin, account) {
    const acctKey = account ?? 'default';
    const login = auth.configIdOf(account);
    const { query } = await state.sdk();
    let release;
    const gate = new Promise((r) => (release = r));
    async function* none() {
      await gate;
    }
    // Asking for fast mode makes the CLI report what blocks it (e.g. extra usage turned off).
    const q = query({
      prompt: none(),
      options: {
        pathToClaudeCodeExecutable: sdkBin(bin),
        extraArgs: noChrome(),
        settingSources: [],
        settings: { fastMode: true },
        env: auth.cleanEnv(account),
      },
    });
    const timeout = new Promise((_, rej) => unrefTimer(() => rej(new Error('Timed out asking Claude Code for its models')), 20000));
    try {
      const init = await Promise.race([q.initializationResult(), timeout]);
      const account = init.account ?? {};
      // the CLI names a login from its config, which can name another account than its token's (harness/claude/loginIdentity.cjs)
      const own = state.accts?.identity(login) ? { email: loginEmail(state.accts, login) } : null;
      const reason = init.fast_mode_disabled_reason ?? null;
      const mode = auth.authMode();
      const models =
        mode === 'mopilot'
          ? withGatewayModels(
              init.models ?? [],
              // without the gateway's capabilities, the CLI's own model list is used as it is
              await state.gatewayCaps().catch((error) => (noteIgnored("read the MoPilot gateway's models", error), null)),
            )
          : withRoutedModels(init.models ?? [], mode === 'routed' ? auth.routedConfig() : null);
      const out = {
        models,
        account: {
          subscriptionType: account.subscriptionType ?? null,
          apiProvider: account.apiProvider ?? null,
          email: own ? own.email : (account.email ?? null),
        },
        fastBlocked: FAST_BLOCKERS.has(reason) ? reason : null,
      };
      probed.set(acctKey, out);
      state.onProbe();
      return out;
    } finally {
      release();
      try {
        q.close();
      } catch (error) {
        // the probe query may already be closed
        noteIgnored('close the Claude Code model probe', error);
      }
    }
  }

  /**
   * Plan usage from the CLI's own `/usage` command: no model call, no tokens, nothing persisted. A login is read in
   * MoPilot's folder for it, so the reading and the account it names are its token's (harness/claude/loginIdentity.cjs); a
   * key's folder is read as it is.
   */
  async function usage(bin, account) {
    const read = (env, hold) =>
      readUsage(
        state.sdk,
        { pathToClaudeCodeExecutable: sdkBin(bin), extraArgs: noChrome(), persistSession: false, maxTurns: 1, settingSources: [], env },
        undefined,
        hold,
      );
    const env = auth.cleanEnv(account);
    const login = state.accts?.identity(auth.configIdOf(account));
    if (!login) return read(env);
    return login.read(
      (hold) => read({ ...env, ...login.env(env) }, hold),
      () => read(env),
    );
  }

  /** The user's Claude skills, commands and MCP servers (Settings → Claude Code → Extensions). Loads user settings, so only on demand. */
  async function extras(bin, cwd, account, requireFolder) {
    const { query } = await state.sdk();
    const executable = sdkBin((await cli.findBinary(bin)) ?? bin);
    const folder = cwd && fs.existsSync(cwd) ? cwd : undefined;
    if (requireFolder === true && !folder) throw new Error("The chat's folder is unavailable.");
    let release;
    const gate = new Promise((r) => (release = r));
    async function* none() {
      await gate;
    }
    // a project's own commands and skills need its folder; the account's, its config folder
    const q = query({
      prompt: none(),
      options: {
        pathToClaudeCodeExecutable: executable,
        extraArgs: noChrome(),
        cwd: folder,
        settingSources: ['user', 'project', 'local'],
        env: auth.cleanEnv(account ?? undefined),
      },
    });
    const timeout = (ms) => new Promise((_, rej) => unrefTimer(() => rej(new Error('Timed out')), ms));
    try {
      const init = await Promise.race([q.initializationResult(), timeout(20000)]);
      // a server list that can't be read is reported as such, not as "no servers"
      /** @type {string | null} */
      let mcpError = null;
      const mcp = await Promise.race([q.mcpServerStatus(), timeout(10000)])
        .then(mcpSettingsRows)
        .catch((error) => {
          mcpError = messageOf(error);
          return [];
        });
      return {
        commands: (init.commands ?? []).map(slashCommand),
        mcp,
        ...(mcpError ? { mcpError } : {}),
      };
    } finally {
      release();
      try {
        q.close();
      } catch (error) {
        // the query may already be closed
        noteIgnored('close the Claude Code extensions query', error);
      }
    }
  }

  /**
   * Summary handoff (design §05): the session writes a note about itself in an unpersisted fork,
   * so the original session is untouched. Tool calls are denied; the note comes from its context.
   */
  async function summarize(sessionId, cwd, prompt, binOverride, account, chatId) {
    const { query } = await state.sdk();
    const bin = await cli.findBinary(binOverride);
    if (!bin) throw new Error('Claude Code is not installed');
    const options = {
      pathToClaudeCodeExecutable: sdkBin(bin),
      extraArgs: noChrome(),
      cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
      resume: sessionId,
      forkSession: true,
      persistSession: false,
      maxTurns: 1,
      permissionMode: 'dontAsk',
      allowedTools: [],
      settingSources: ['user', 'project', 'local'],
      env: auth.cleanEnv(account),
    };
    // a MoMo chat's note is written without the user's coding-side instructions, memory or tools (#2364)
    if (chatId && state.isolated?.(chatId)) confineHelperOptions(options);
    // the MCP gateway's servers stay out of its note too: the user's allow rules could otherwise run their own copy (gatewayNative.cjs)
    else denyManaged(options, state.sageTools?.gatewayDenials?.() ?? []);
    return helperReply(query({ prompt, options }));
  }

  /** A title CLI's options: no settings, tools or MCP servers, on the cheapest model, as the chat's own account (D-65). */
  const titleOptions = (bin, cwd, account) => ({
    pathToClaudeCodeExecutable: sdkBin(bin),
    extraArgs: noChrome(),
    cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
    model: 'haiku',
    maxTurns: 1,
    tools: [],
    permissionMode: 'dontAsk',
    persistSession: false,
    settingSources: [],
    systemPrompt: 'You write short titles for coding tasks. Reply with the title only.',
    env: auth.cleanEnv(account),
  });
  /** The warm title CLI per login (titleHelper.cjs); a composer's prewarm starts it (warm.cjs). */
  const helper = createTitleHelper({
    sdk: () => state.sdk(),
    sig: () => auth.billingSig?.() ?? '',
    options: async (account, binOverride) => {
      const bin = await cli.findBinary(binOverride);
      return bin ? titleOptions(bin, null, account) : null;
    },
  });
  state.titleHelper = helper;

  /**
   * A short title for a chat, written as the chat's own account: by the warm helper at send (`o.helper`; null when it
   * can't, or for a MoMo chat, whose title is written only by a confined CLI), else by a one-shot, unpersisted CLI.
   */
  async function title(prompt, cwd, binOverride, account, chatId, o = {}) {
    if (o.helper)
      return chatId && state.isolated?.(chatId)
        ? null
        : helper.title(prompt, account, binOverride).catch((error) => (noteIgnored('ask the title helper', error), null));
    const { query } = await state.sdk();
    const bin = await cli.findBinary(binOverride);
    if (!bin) return null;
    const options = titleOptions(bin, cwd, account);
    if (chatId && state.isolated?.(chatId)) confineHelperOptions(options);
    // a failed query throws: the caller (autoTitle.cjs landTitle) keeps the provisional title and notes why
    return (await helperReply(query({ prompt: titlePrompt(prompt), options }))) || null;
  }

  return { probeInfo, probe, usage, extras, summarize, title };
}

module.exports = { createQueries, withGatewayModels, withRoutedModels };
