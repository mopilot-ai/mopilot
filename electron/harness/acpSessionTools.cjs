// Prepare ACP tool channels and plugin servers, retaining folders until the owning session ends.
const { noteIgnored } = require('../ignored.cjs');

/** Let go of the plugin folders a chat's session was given (once: a second call does nothing). */
function releasePlugins(chat) {
  chat.releasePlugins?.();
  chat.releasePlugins = null;
}

/**
 * Whether a harness gets MoPilot's tools over http: one that takes no stdio MCP server (its quirks say
 * mcpStdio: false, as Copilot CLI's do) and says in initialize that it takes http ones.
 */
const toolsOverHttp = (quirks, caps) => quirks?.mcpStdio === false && !!caps?.mcp?.http;

async function prepareSessionTools(host, chat, agent, prev) {
  let mcpServers = [];
  if (host.tools) {
    const t = await host.tools.prepare(chat.key, {
      harnessPid: agent.pid,
      chatId: chat.chatId,
      segmentId: chat.key,
      resume: !!prev,
      http: toolsOverHttp(host.quirksOf(chat.harness), agent.caps),
    });
    host.assertChatCurrent(chat);
    chat.serverName = t.serverName;
    mcpServers = t.mcpServers;
  }
  // a chat kept apart from the coding side (MoMo's) gets MoMo's tools through its own server only
  if (host.plugins && !chat.isolated) {
    // MoPilot's plugins' MCP servers, in the transports this agent takes; the rest is withheld with why
    /** @type {{mcpServers: object[], release: () => unknown, withheld: {id: string, why: string}[]} | null} */
    let d = null;
    try {
      d = await host.plugins.forAcp({ mcp: agent.caps?.mcp, stdio: host.quirksOf(chat.harness)?.mcpStdio !== false });
    } catch (error) {
      // the session starts without them rather than not at all; the Plugins page says what each harness gets
      noteIgnored(`give ${host.label(chat.harness)} its plugins`, error);
    }
    if (d) {
      chat.releasePlugins = d.release;
      host.assertChatCurrent(chat);
      mcpServers = [...mcpServers, ...d.mcpServers];
      for (const w of d.withheld) noteIgnored(`give ${host.label(chat.harness)} a plugin`, new Error(`${w.id}: ${w.why}`));
    }
  }
  return mcpServers;
}

module.exports = { prepareSessionTools, releasePlugins, toolsOverHttp };
