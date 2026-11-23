// Prepare a Claude session's shared tool servers and native plugin folders before the SDK query starts.
const crypto = require('node:crypto');
const { injectSdkMcpServers } = require('../../capabilities/mcp/sdkMcp.cjs');
const { hideRule } = require('../../capabilities/contract/toolRefusal.cjs');
const { surfaceNote, claudeNames } = require('../../capabilities/contract/surfaceNote.cjs');
const { withSessionsNote } = require('../../capabilities/contract/sessionsNote.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { segmentKey } = require('../../platform/segmentOwner.cjs');
const { chatOfOwner } = require('../../capabilities/contract/session.cjs');
const { isolateOptions, confineTools } = require('./isolation.cjs');
const { denyManaged } = require('./gatewayNative.cjs');

async function prepareSessionTools(state, cli, bin, options, s, opts, key, chatOfProcess) {
  // a chat kept apart from the coding side (MoMo's) starts without the user's instructions and memory, and with only
  // MoPilot's own tools (harness/claude/isolation.cjs)
  const isolated = typeof s.isolated === 'boolean' ? s.isolated : state.isolated?.(opts.chatId || chatOfProcess()) === true;
  if (isolated) {
    isolateOptions(options);
    // only the tools of MoPilot's servers this session was given (injectSdkMcpServers' names, set below)
    confineTools(options, (name) => s.sageTools instanceof Set && s.sageTools.has(name));
  }
  // the channel's remote switch (channel.claude.sdkMcp): off, the session starts without MoPilot's tools
  const tools = state.sageTools;
  if (tools && tools.enabled?.() !== false) {
    // a new server per process: its handlers know which chat they serve only through this closure; the name is the
    // same for every process, so the tools open the same cached prompt prefix (#2579)
    s.toolKey = `claude:${key}:${crypto.randomUUID()}`;
    // a process started without its chat (an edit-message rewind) finds it from the session at each call; the segment
    // goes by the key its chat records it under, as every owner check compares (platform/segmentOwner.cjs)
    const owner = { chatId: opts.chatId || chatOfProcess, segmentId: opts.sessionId ? segmentKey('claude', opts.sessionId) : key };
    const { serverName } = tools.sessions.open(s.toolKey, { ...owner, shared: 'claude' });
    // with Claude in Chrome the session keeps MoPilot's other tools, but not a second controller for Chrome
    const hideTool = tools.hideTool;
    const hide = s.nativeChrome && typeof hideTool === 'function' ? hideRule(hideTool, hideTool.message) : null;
    // the in-app browser and desktop tools go on servers of their own (mopilot_browser, mopilot_computer) with
    // the short names Claude knows from Anthropic's desktop app; every other tool on the sage_<nonce> server
    // what the tools reach, under the names this session sees (#1319 G3): MCP instructions, so the preset prompt stays as it is
    const shown = tools.registry
      .list({ chatId: chatOfOwner(owner.chatId) })
      .map((t) => t.name)
      .filter((n) => !hide?.(n));
    const naming = claudeNames(serverName);
    const yourChrome = tools.yourChrome?.() ?? false;
    const injected = injectSdkMcpServers(options, {
      sdk: await state.sdk(),
      z: require('zod'),
      registry: tools.registry,
      serverName,
      owner,
      hide,
      // the user's Chrome's core tools load up front only when it is the chosen browser (capabilities/mcp/toolLoading.cjs)
      chromeCore: yourChrome !== false,
      // and, when it may start sessions, how to start, offer or propose one (capabilities/contract/sessionsNote.cjs)
      instructions: withSessionsNote(surfaceNote(shown, { yourChrome, ownChrome: !!s.nativeChrome, naming }), shown, naming),
    });
    if (injected.servers.length) s.sageTools = injected.tools;
    else tools.sessions.end(s.toolKey);
  }
  // the session's own copies of the servers MoPilot's gateway runs never load: denied by identity in its flag settings
  // (gatewayNative.cjs); a chat kept apart loads none of the user's servers (strictMcpConfig)
  if (!isolated && typeof tools?.gatewayDenials === 'function') denyManaged(options, tools.gatewayDenials());
  // MoPilot's plugins, each folder loaded by the CLI itself; one the account already turns on is left to it.
  // A CLI too old for --plugin-dir starts without them (it would refuse to start with the flag). An isolated session
  // loads none (their MCP servers, hooks and agents would be the CLI's, not MoMo's): plugin_skills serves their skills.
  const loadsPlugins = !!state.plugins && !isolated && (await cli.takesPluginDirs(bin));
  // while it can't, plugin_skills serves the plugins' skills and commands to it instead
  const releaseNative = state.plugins?.markNative('claude', loadsPlugins, opts.chatId || chatOfProcess());
  s.releasePlugins = releaseNative;
  if (state.plugins) s.pluginDirs = loadsPlugins;
  if (state.plugins && !loadsPlugins) {
    if (!isolated)
      noteIgnored(
        'give a Claude Code session its plugins',
        new Error("This Claude Code version can't load plugins. Update it to use them."),
      );
  } else if (state.plugins) {
    try {
      const d = await state.plugins.forClaude({ configDir: options.env?.CLAUDE_CONFIG_DIR, cwd: opts.cwd });
      options.plugins = [...(options.plugins ?? []), ...d.plugins];
      s.releasePlugins = () => {
        releaseNative?.();
        return d.release();
      };
      for (const w of d.withheld) noteIgnored('give a Claude Code session a plugin', new Error(`${w.id}: ${w.why}`));
    } catch (error) {
      // the session starts without them rather than not at all; the Plugins page says what each harness gets
      releaseNative?.fail?.();
      s.pluginDirs = false;
      noteIgnored('give a Claude Code session its plugins', error);
    }
  }
}

module.exports = { prepareSessionTools };
