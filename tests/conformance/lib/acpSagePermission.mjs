// #1319 G9 against a real installed ACP harness: does its permission request for one of MoPilot's own tools carry
// the sage_<nonce> server name (in toolCall.title or _meta), so that isSageToolCall skips the harness's card? If not,
// the user gets the harness's card and then MoPilot's (a double card). One cheap prompted turn, through the real AcpHost
// and the tool channel admission gives the harness (stdio sage-mcp, or main's http endpoint for Copilot CLI).
import path from 'node:path';
import { app, tempDir, toolChannel, until } from './acp.mjs';
import { transcriptFixture } from '../../support/transcript-fixture.ts';
import { acpFixtureStop } from '../../support/acp-fixture-stop.mjs';

/** The prompt: one call of MoPilot's echo tool. */
export const PROMPT =
  'Call the sage_debug_echo tool (from the MCP server whose name starts with "sage_") once, with the text "g9", and reply with exactly what it returned. Use no other tool.';

/**
 * What one turn showed about the echo tool's permission request. The prompt allows that tool only, so every request
 * isSageToolCall did not match is a card the user would see before MoPilot's own (however the harness titled it).
 * - `fail`: a request nothing matched (a double card); the raw toolCalls are kept for a per-quirk fix;
 * - `pass`: the echo tool ran, and every request matched (its card is skipped, MoPilot's gate decides);
 * - `no-card`: the echo tool ran with no request at all (no double card either);
 * - `not-called`: the echo tool never ran (the turn proves nothing), or the turn did not end.
 * @param {{ requests: { serverName: string, toolCall: any, sage: boolean }[], calls: number, ended: boolean }} o
 */
export function verdictOf({ requests, calls, ended }) {
  if (requests.some((r) => !r.sage)) return 'fail';
  if (!calls || !ended) return 'not-called';
  return requests.length ? 'pass' : 'no-card';
}

/**
 * Runs the check on harness `id` as installed (SAGE_ACP_BINS or PATH, as admission finds it).
 * @param {string} id @param {{ timeoutMs?: number }} [o]
 */
export async function probeSagePermission(id, { timeoutMs = 240_000 } = {}) {
  const { acp, ItemsLog, quirks, pty, shellEnv, isSageToolCall } = app();
  await shellEnv.init();
  const q = quirks.quirks(id);
  const transport = q.mcpStdio === false ? 'http' : 'stdio';
  const bin = quirks.findBin(id, (b) => shellEnv.which(b));
  if (!bin) return { id, transport, verdict: 'missing', requests: [] };
  // the echo tool's calls, counted where MoPilot runs it (the registry keeps a copy of the tool as it registers it)
  let calls = 0;
  const { echo } = app();
  const handler = echo.handler;
  echo.handler = (/** @type {any} */ args, /** @type {any[]} */ ...rest) => (calls++, handler(args, ...rest));
  /** @type {ReturnType<typeof toolChannel>} */
  let tools;
  try {
    tools = toolChannel({ echo: true });
  } finally {
    echo.handler = handler;
  }
  const { channel, close } = tools;
  const dir = tempDir('mopilot-g9-');
  const fixture = transcriptFixture(dir);
  /** @type {{ serverName: string, toolCall: any, sage: boolean }[]} */
  const requests = [];
  const events = [];
  const h = new acp.AcpHost({
    items: fixture.own(new ItemsLog(path.join(dir, 'threads'))),
    quirks: quirks.quirks,
    ids: quirks.ids(),
    resolveBin: (x) => (x === id ? bin : null),
    env: () => shellEnv.childEnv(),
    tools: channel,
    pty,
    cwd: dir,
    dataDir: path.join(dir, 'data'),
    admitted: () => null,
  });
  fixture.stopWith(acpFixtureStop(h));
  fixture.stopWith(close);
  // what the harness sent, before the host decides (MoPilot's own tool: allowed once; anything else: the card below)
  const decide = h.requestPermission.bind(h);
  h.requestPermission = (chat, params) => {
    requests.push({
      serverName: chat.serverName,
      toolCall: params?.toolCall ?? null,
      sage: isSageToolCall(params?.toolCall, chat.serverName),
    });
    return decide(chat, params);
  };
  h.on('event', (e) => {
    events.push(e);
    // a card the harness raised: answered as a user clicking Allow once
    if (e.kind === 'permission') setTimeout(() => h.permission(e.requestId, e.options.find((o) => o.kind === 'allow_once')?.optionId), 5);
  });
  const key = `acp:${id}:g9`;
  let ended = false;
  /** @type {string | null} the harness mode the turn ran in */
  let mode = null;
  /** @type {string | null} */
  let error = null;
  /** @type {string | null} */
  let version = null;
  try {
    // in MoPilot's Ask, where a harness asks before acting: the mode its quirks give the composer's default row (or
    // anchor at ask), set as the app does, on the session or as its mode option
    const chat = await h.ensure(key, { cwd: dir });
    mode = askModeOf(q);
    if (mode && chat.state?.modes?.availableModes?.some((/** @type {any} */ m) => m.id === mode)) await h.setMode(key, mode);
    else {
      const option = chat.state?.configOptions?.find(
        (/** @type {any} */ o) => o.category === 'mode' && o.options?.some((/** @type {any} */ v) => v.value === mode),
      );
      if (mode && option) await h.setConfigOption(key, option.id, mode);
      else mode = null;
    }
    const { turnId } = await h.send(key, { cwd: dir, blocks: [{ type: 'text', text: PROMPT }], display: [] }, {});
    await until(() => events.find((e) => e.kind === 'turnEnd' && e.turnId === turnId), timeoutMs);
    ended = true;
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 300);
  } finally {
    // the version the agent reports in initialize, as admission records it; the agent is ended here, whatever the
    // turn did, so nothing of it outlives the check
    const agent = await h.agents.get(id)?.catch(() => null);
    version = agent?.init?.agentInfo?.version ?? null;
    await fixture.cleanup();
  }
  return {
    id,
    version,
    transport,
    mode,
    verdict: verdictOf({ requests, calls, ended }),
    requests,
    calls,
    ended,
    ...(error ? { error } : {}),
  };
}

/**
 * The harness mode that is MoPilot's Ask: the one its quirks give the composer's default row (permissionModes), else
 * the one anchored at ask; null when it has neither (the harness's own default mode is used).
 * @param {{ permissionModes?: Record<string, string>, anchors?: Record<string, string> }} q
 */
export function askModeOf(q) {
  const row = Object.entries(q.permissionModes ?? {}).find(([, r]) => r === 'default');
  return (row ?? Object.entries(q.anchors ?? {}).find(([, a]) => a === 'ask'))?.[0] ?? null;
}
