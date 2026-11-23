// Turn details both fake harnesses script alike, each in its own protocol: thinking ahead of the reply (THINK, and
// THINKTWICE's two thoughts back to back), hook runs that pass or fail (HOOKOK, HOOKFAIL), a context reading (CTXUSE),
// a held turn (a "<log>.hold-next" file holds the next turn until "<log>.release"), Codex's review in its findings
// format (FAKE_CODEX_REVIEW_FINDINGS=1), a Claude 1M model (FAKE_CLAUDE_1M=1), Claude's foreground sub-agent (FGTASK) and a
// slow chat CLI start (~/.fake-hold-start).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Each of THINKTWICE's thoughts runs this long: alone under the 0.5 s a "Thought for" needs, the two together over it. */
export const THOUGHT_MS = 400;
export const THOUGHTS = ['fake first thought', 'fake second thought'];
/** THINK's one summary (settings-reasoning reads it). */
const THINK_SUMMARY = '**Weighing it up**\n\nfake-codex reasoning summary';
/** Why HOOKFAIL's Stop hook failed, on both harnesses. */
export const HOOK_FAILURE = 'lint found 3 problems';
/** Why HOOKEARLY's SessionStart hook failed: Codex reports it with no turn (#2066). */
export const HOOK_EARLY_FAILURE = 'session setup failed: .env is missing';
/** All a passing hook printed: a Node runtime warning, which shows nothing. */
export const RUNTIME_WARNING = '(node:4242) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file is not specified';
/** CTXUSE's reading on each harness: tokens in use of the model's window. */
export const CONTEXT = { codex: { used: 231000, window: 272000 }, claude: { used: 100000, window: 200000 } };

/** The thoughts a turn has ahead of its reply, with how long each takes. */
export function thoughtsFor(text) {
  if (text.includes('THINKTWICE')) return THOUGHTS.map((summary) => ({ summary, ms: THOUGHT_MS }));
  return text.includes('THINK') ? [{ summary: THINK_SUMMARY, ms: 15 }] : [];
}

/**
 * Codex: each thought as a reasoning item of the turn, streamed as a summary like the real app-server's; then, for
 * "ASKASYNC", a question asked in an async agent message (delivery 'async') and a command run after it in the same turn,
 * as an agent asks and keeps working (with SLOW, the turn waits for the answer, which comes back as a steer).
 * @param {string} text
 * @param {{ notify: (method: string, params: any) => unknown, sleep: (ms: number) => Promise<unknown>, turn: { items: any[] },
 *           threadId: string, turnId: string, cwd?: string | null }} o
 */
export async function streamCodexThoughts(text, { notify, sleep, turn, threadId, turnId, cwd = null }) {
  for (const { summary, ms } of thoughtsFor(text)) {
    /** @type {{ type: 'reasoning', id: string, summary: string[], content: unknown[] }} */
    const reasoning = { type: 'reasoning', id: randomUUID(), summary: [], content: [] };
    turn.items.push(reasoning);
    notify('item/started', { item: { ...reasoning }, threadId, turnId, startedAtMs: Date.now() });
    notify('item/reasoning/summaryPartAdded', { threadId, turnId, itemId: reasoning.id, summaryIndex: 0 });
    await sleep(ms);
    notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: reasoning.id, summaryIndex: 0, delta: summary });
    reasoning.summary = [summary];
    notify('item/completed', { item: { ...reasoning }, threadId, turnId, completedAtMs: Date.now() });
  }
  if (!text.includes('ASKASYNC')) return;
  const asked = {
    type: 'agentMessage',
    id: randomUUID(),
    text: '',
    phase: null,
    memoryCitation: null,
    delivery: 'async',
    questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }],
  };
  const working = {
    type: 'commandExecution',
    id: randomUUID(),
    command: 'echo still working',
    cwd,
    processId: null,
    source: 'agent',
    status: 'completed',
    commandActions: [],
    aggregatedOutput: 'still working\n',
    exitCode: 0,
    durationMs: 1,
  };
  for (const item of [asked, working]) {
    turn.items.push(item);
    notify('item/started', { item: { ...item }, threadId, turnId, startedAtMs: Date.now() });
    await sleep(15);
    notify('item/completed', { item: { ...item }, threadId, turnId, completedAtMs: Date.now() });
  }
}

/** Codex's hook runs for a turn (hook/completed's HookRunSummary): a passing SessionStart and a failing Stop. */
export function codexHookRuns(text, at = Date.now()) {
  const run = (eventName, status, entries) => ({
    id: randomUUID(),
    eventName,
    handlerType: 'command',
    executionMode: 'sync',
    scope: 'project',
    sourcePath: '/repo/.codex/hooks.json',
    source: 'project',
    displayOrder: 0,
    status,
    statusMessage: null,
    startedAt: at,
    completedAt: at,
    durationMs: 1,
    entries,
  });
  return [
    ...(text.includes('HOOKOK') ? [run('sessionStart', 'completed', [{ kind: 'warning', text: RUNTIME_WARNING }])] : []),
    ...(text.includes('HOOKFAIL') ? [run('stop', 'failed', [{ kind: 'error', text: HOOK_FAILURE }])] : []),
    ...(text.includes('HOOKEARLY') ? [run('sessionStart', 'failed', [{ kind: 'error', text: HOOK_EARLY_FAILURE }])] : []),
  ];
}

/** Codex: what ends a turn before turn/completed: its hook runs, and CTXUSE's token usage. */
export function codexTurnEnd(text, { notify, threadId, turnId }) {
  // a failed SessionStart belongs to the session, not a turn: Codex sends it with turnId null
  for (const run of codexHookRuns(text))
    notify('hook/completed', { threadId, turnId: run.eventName === 'sessionStart' && run.status === 'failed' ? null : turnId, run });
  if (!text.includes('CTXUSE')) return;
  const { used, window } = CONTEXT.codex;
  const last = {
    totalTokens: used,
    inputTokens: used - 1000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1000,
    reasoningOutputTokens: 0,
  };
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: last, last, modelContextWindow: window } });
}

/** Codex's review result: one line, or with FAKE_CODEX_REVIEW_FINDINGS its findings format on `cwd`/calc.js. */
export function codexReviewText(cwd, env = process.env) {
  if (env.FAKE_CODEX_REVIEW_FINDINGS !== '1') return '[P1] Fake finding: a+b became a-b';
  const at = `${cwd}/calc.js:1-1`;
  return [
    'Two issues in calc.js.',
    '',
    'Full review comments:',
    '',
    `- [P1] div multiplies instead of dividing — ${at}`,
    '  div(6, 3) returns 18 instead of 2.',
    '  Every caller that divides gets a product back.',
    '  The unit tests never call div.',
    '',
    `- [P2] No test covers div — ${at}`,
    '  A regression in div ships unnoticed.',
    '  Add a test that divides 6 by 3.',
    '  Keep it next to the add test.',
  ].join('\n');
}

/** Claude Code: each thought as its own thinking block, streamed, then the assistant message holding it. Returns the text block's index. */
export async function streamClaudeThoughts(text, { event, sleep, send, message }) {
  const thoughts = thoughtsFor(text);
  for (const [index, { summary, ms }] of thoughts.entries()) {
    event({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    event({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: summary } });
    await sleep(ms);
    event({ type: 'content_block_stop', index });
    const content = [{ type: 'thinking', thinking: summary, signature: 'fake' }];
    send({
      type: 'assistant',
      message: { ...message, type: 'message', role: 'assistant', content, stop_reason: null, stop_sequence: null },
    });
  }
  return thoughts.length;
}

/** Claude Code's hook telemetry plus the native notice carrying a failed Stop hook's user-facing feedback. */
export function claudeHookResponses(text) {
  const hook = (hook_id, hook_name, hook_event, stderr, exit_code, outcome) => ({
    type: 'system',
    subtype: 'hook_response',
    hook_id,
    hook_name,
    hook_event,
    output: stderr,
    stdout: '',
    stderr,
    exit_code,
    outcome,
  });
  return [
    ...(text.includes('HOOKOK') ? [hook('h0', 'SessionStart:startup', 'SessionStart', RUNTIME_WARNING, 0, 'success')] : []),
    ...(text.includes('HOOKFAIL')
      ? [
          hook('h1', 'lint', 'Stop', HOOK_FAILURE, 2, 'error'),
          { type: 'system', subtype: 'informational', uuid: randomUUID(), level: 'warning', content: HOOK_FAILURE },
        ]
      : []),
  ];
}

/** Claude Code's usage for a reply: with CTXUSE, cache reads fill the context to CONTEXT.claude.used; with CTXOVER, to 300k, past the 200k window the fake CLI reports. */
export function claudeUsage(text, reply) {
  const usage = {
    input_tokens: 10,
    output_tokens: Math.ceil(reply.length / 4),
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  if (text.includes('CTXUSE')) usage.cache_read_input_tokens = CONTEXT.claude.used - usage.input_tokens - usage.output_tokens;
  if (text.includes('CTXOVER')) usage.cache_read_input_tokens = 300_000;
  return usage;
}

/**
 * Models a test adds to the fake Claude CLI's list: with FAKE_CLAUDE_1M, Haiku's 1M-context variant; with
 * FAKE_CLAUDE_FAST, a model that supports Fast (which the fake's account still blocks: extra usage is off).
 */
export const extraClaudeModels = (env = process.env) => [
  ...(env.FAKE_CLAUDE_1M === '1'
    ? [{ value: 'haiku[1m]', displayName: 'Fake Haiku', description: 'A scripted model for tests', resolvedModel: 'claude-fake-haiku[1m]' }]
    : []),
  ...(env.FAKE_CLAUDE_FAST === '1'
    ? [
        {
          value: 'fastopus',
          displayName: 'Fake Fast Opus',
          description: 'A scripted model with Fast',
          resolvedModel: 'claude-fake-fast-opus',
          supportedEffortLevels: ['low', 'medium', 'high'],
          supportsEffort: true,
          supportsFastMode: true,
        },
      ]
    : []),
];

/** Whether a test asked to hold this turn ("<log>.hold-next"): the file is taken, so only one turn is held. */
export function heldNext(log) {
  const file = `${log}.hold-next`;
  if (!log || !fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** Resolves once the test writes "<log>.release", which it takes. */
export function released(log, poll = 50) {
  const file = `${log}.release`;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!fs.existsSync(file)) return;
      fs.rmSync(file, { force: true });
      clearInterval(timer);
      resolve(undefined);
    }, poll);
  });
}

/** The cloud-provider variables the CLI was started with (names only), and the connector switch with its value (MoMo's session turns it off, #2318). */
export function cloudEnvOf() {
  const names = Object.keys(process.env).filter((k) => /^(CLAUDE_CODE_(USE|SKIP)_|AWS_|ANTHROPIC_VERTEX_|GOOGLE_APPLICATION_)/.test(k));
  if (process.env.ENABLE_CLAUDEAI_MCP_SERVERS !== undefined)
    names.push(`ENABLE_CLAUDEAI_MCP_SERVERS=${process.env.ENABLE_CLAUDEAI_MCP_SERVERS}`);
  return names.sort();
}

/** LABELCHURN's Bash descriptions: long and distinct, each a running label of its own ("Running a search for Bosch 800 Series 36…"). */
const LABEL_CHURN = [
  'Search the web for Bosch 800 Series 36 in induction cooktop reviews and street prices',
  'Search the web for Samsung NZ36C3060UK replacement models and where they are in stock',
  'Fetch the Home Depot product page for the Tomfaucet kitchen faucet and read its image gallery',
  'Compare Ferguson and Build.com listings for the Bosch NIT8660UC induction cooktop',
  'Check whether the Cafe 36 in smart induction cooktop is available for delivery this month',
  'Read the installation manual for a 36 in induction cooktop and note the cutout dimensions',
  'Summarize the warranty terms of every cooktop in the shortlist in one short paragraph each',
  'Write the final shopping list with a thumbnail for each product and a link to the best price',
];

/**
 * LABELCHURN (#4654): 24 Bash calls in a row with long descriptions (LABEL_CHURN, round and round), each up ~1.1 s, so the live
 * status label keeps changing and truncating; the last is held until "<log>.release". `toolRound` is fake-claude's.
 */
async function labelChurn(toolRound, log) {
  const rounds = 24;
  for (let i = 0; i < rounds; i += 1)
    await toolRound('Bash', { command: 'npm test', description: LABEL_CHURN[i % LABEL_CHURN.length] }, async () => {
      await (i === rounds - 1 ? released(log) : new Promise((r) => setTimeout(r, 1100)));
      return { text: 'ok' };
    });
}

/** FGTASK's Agent call: a sub-agent the model waits on, as the user's report had ("Reading how … is stored"). */
export const FG_AGENT = { description: 'Read how memory is stored', prompt: 'look at the memory files', subagent_type: 'Explore' };

/**
 * FGTASK: Claude's foreground sub-agent as the CLI reports it, run as the Agent call's tool (toolRound): task_started,
 * a step of its own (a Read under the Agent call) and a progress summary, then it runs until the test writes
 * "<log>.release" (harness.releaseClaudeCommand), so a spec can watch the turn while its only work is the sub-agent.
 */
export async function foregroundAgent(toolUseId, { send, sessionId, log }) {
  const base = { session_id: sessionId };
  const task_id = `task_${randomUUID().slice(0, 6)}`;
  const { description } = FG_AGENT;
  const task = { task_id, tool_use_id: toolUseId, description };
  send({
    type: 'system',
    subtype: 'task_started',
    ...task,
    task_type: 'local_agent',
    subagent_type: 'Explore',
    is_backgrounded: false,
    ...base,
    uuid: randomUUID(),
  });
  const read = {
    type: 'tool_use',
    id: `toolu_fake_${randomUUID().slice(0, 8)}`,
    name: 'Read',
    input: { file_path: `${process.cwd()}/README.md` },
  };
  const message = {
    id: `msg_fake_${randomUUID().slice(0, 8)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [read],
    stop_reason: 'tool_use',
  };
  send({ type: 'assistant', message, parent_tool_use_id: toolUseId, ...base, uuid: randomUUID() });
  const usage = { total_tokens: 10, tool_uses: 1, duration_ms: 5 };
  send({
    type: 'system',
    subtype: 'task_progress',
    ...task,
    usage,
    last_tool_name: 'Read',
    summary: 'Reading README.md',
    ...base,
    uuid: randomUUID(),
  });
  if (log) await released(log);
  send({
    type: 'system',
    subtype: 'task_notification',
    ...task,
    status: 'completed',
    output_file: '',
    summary: `${description} completed`,
    ...base,
    uuid: randomUUID(),
  });
  return { text: 'Memory lives in one file per fact.' };
}

/**
 * A chat's CLI starting as slowly as a real one loading MCP servers, plugins and hooks: while ~/.fake-hold-start exists it
 * reads no input, so it answers neither its prompt nor a control request (#3413). Other CLIs (the title CLI) start at once.
 */
export function holdStart(chat) {
  while (chat && fs.existsSync(path.join(os.homedir(), '.fake-hold-start')))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}

/** FGTASK (a foreground Agent call) and LABELCHURN (a run of Bash calls) of a turn's text, run through fake-claude's toolRound. */
export async function scriptedToolTurns(text, toolRound, ctx) {
  if (text.includes('FGTASK')) await toolRound('Agent', FG_AGENT, (id) => foregroundAgent(id, ctx));
  if (text.includes('LABELCHURN')) await labelChurn(toolRound, ctx.log);
}
