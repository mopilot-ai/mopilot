// Reads how a turn went: a desktop app's own transcript on disk (Claude Code JSONL or a Codex rollout), found by the
// run tag, and MoPilot's activity summaries in its chat view. Gives done, answer, steps, tool counts and rule breaks.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseJsonl, ruleBreaks } from './grading.mjs';
import { endsClaudeTurn } from '../../shared/claudeEndTurn.mjs';

/** Where each harness keeps its transcripts, and how deep they sit. @param {'claude' | 'codex'} kind @param {string} home */
export const transcriptRoot = (kind, home) =>
  kind === 'claude' ? { dir: path.join(home, '.claude/projects'), depth: 1 } : { dir: path.join(home, '.codex/sessions'), depth: 3 };

/** JSONL files under dir, at most depth folders down. @param {string} dir @param {number} depth */
function jsonlFiles(dir, depth) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out = out.concat(jsonlFiles(p, depth - 1));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * The newest transcript, changed in the last hour, that holds the tag; null when none does yet. Newest, because an
 * app can move a chat to a new file: the ChatGPT app can start a new rollout (a new session, counting its own turns
 * and tokens) for a later message, and that file holds the tag too.
 * @param {'claude' | 'codex'} kind @param {string} home @param {string} tag
 */
export function findTranscript(kind, home, tag, now = Date.now()) {
  const { dir, depth } = transcriptRoot(kind, home);
  /** @type {{ f: string, t: number } | null} */
  let best = null;
  for (const f of jsonlFiles(dir, depth)) {
    const t = mtimeOf(f);
    if (now - t >= HOUR || !readFileSync(f, 'utf8').includes(tag)) continue;
    if (!best || t > best.t) best = { f, t };
  }
  return best?.f ?? null;
}

/** A file's change time; 0 for a file removed since it was listed. @param {string} f */
function mtimeOf(f) {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

const HOUR = 3600e3;

/** Whether a file changed in the last hour; a file removed since it was listed is not. */
export const recent = (/** @type {string} */ f, /** @type {number} */ now) => now - mtimeOf(f) < HOUR;

/** @param {string[]} tools */
function toolCounts(tools) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const t of tools) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}

const ACCESS_CALL = /request_access$/;
const WAITS_ON_PERSON = /request_access$|AskUserQuestion$/;
/**
 * Whether an access result denied an app: a non-empty `denied` list in its JSON (a granted result carries `"denied":[]`),
 * or, for text that is not JSON, the app's `user_denied` reason. @param {string} text
 */
function isDenied(text) {
  try {
    const list = JSON.parse(text)?.denied;
    if (Array.isArray(list) && list.length) return true;
  } catch {
    // not JSON: judged by its text below
  }
  return /user_denied/.test(text);
}
/** A tool result's text, whether the record holds a string or content blocks. @param {any} content */
const resultText = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c?.text ?? '').join(' ') : '';

/**
 * A turn's state from its transcript text.
 * Claude Code: done when the last assistant or user record is an assistant message that ended its turn, so a message
 * sent after an earlier turn ended (a task's next message) reads as running until the agent answers it; meta records
 * the app adds (isMeta) do not count. Codex: done on a
 * task_complete, turn_complete or turn_aborted event after the last start.
 * A Claude Desktop turn can also end on a host tool's result (its wrap-up box, `…wrap_up`, whose result carries the
 * CLI's end-turn flag) with no closing message: that is done too, and the box's recap is the answer.
 * `question`: a Claude Code turn with an AskUserQuestion call still waiting for its answer (even beside other calls); nobody
 * answers it in a benchmark run, so the turn has ended by asking (null otherwise).
 * `pending`: the Claude Code tool call the turn is waiting on ({ id, name }), or null: the newest call without a result,
 * a call that waits on a person (app access, a question) first. A native driver answers the approval cards
 * (computer-use app access). `denials`: ids of app-access calls whose result says denied.
 * `prompts`: how many messages the chat has had (Claude Code: user records with text, not tool results; Codex: turn
 * starts), so a driver that sends another message reads the turn only once that message is in the transcript.
 * @param {'claude' | 'codex'} kind @param {string} text
 */
export function readTranscript(kind, text) {
  const lines = parseJsonl(text);
  let done = false;
  let answer = '';
  /** @type {string | null} */
  let question = null;
  /** @type {{ id: string, name: string } | null} */
  let pending = null;
  /** ids of app-access cards the app denied (a timeout reads as user_denied) */
  const denials = [];
  let prompts = 0;
  /** @type {string[]} */
  const tools = [];
  if (kind === 'claude') {
    /** @type {any} */
    let last = null;
    /** the turn-ending host calls by tool_use id, with their recap */
    const enders = new Map();
    /** tool calls still without a result, by id, in the order they were issued (a parallel call's sibling can answer first) */
    const open = new Map();
    for (const d of lines) {
      const content = Array.isArray(d.message?.content) ? d.message.content : [];
      if (d.type === 'assistant') {
        last = d;
        for (const c of content) {
          if (c.type === 'tool_use') {
            tools.push(c.name);
            open.set(String(c.id), c);
          }
          if (c.type === 'tool_use' && /wrap_up$/.test(c.name)) enders.set(c.id, String(c.input?.recap ?? ''));
          if (c.type === 'text') answer = c.text;
        }
      }
      if (d.type === 'user' && !d.isMeta) {
        last = d;
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          const id = String(c.tool_use_id);
          const call = open.get(id);
          if (call && ACCESS_CALL.test(call.name) && isDenied(resultText(c.content))) denials.push(id);
          open.delete(id);
        }
        const text = typeof d.message?.content === 'string' || content.some((/** @type {any} */ c) => c.type === 'text');
        if (text && !content.some((/** @type {any} */ c) => c.type === 'tool_result')) prompts++;
      }
    }
    done = last?.type === 'assistant' && last.message?.stop_reason === 'end_turn';
    const ended = last?.type === 'user' && Array.isArray(last.message?.content) ? last.message.content : [];
    // only a box that ended the turn (the CLI's end-turn flag on its result): after a recap alone the closing message comes
    const ender = ended.find((/** @type {any} */ c) => c.type === 'tool_result' && enders.has(c.tool_use_id));
    if (ender && endsClaudeTurn(last)) {
      done = true;
      answer = enders.get(ender.tool_use_id) || answer;
    }
    // what the turn waits on is any call still without a result, not only the last record's: a parallel sibling's result
    // can arrive first and make a user record the last one while a person's card is still open
    const calls = [...open.values()];
    const ask = calls.findLast((c) => /AskUserQuestion$/.test(c.name));
    if (ask) question = String(ask.input?.questions?.[0]?.question ?? ask.input?.question ?? 'a question');
    const waiting = calls.findLast((c) => WAITS_ON_PERSON.test(c.name)) ?? calls.at(-1);
    if (waiting) pending = { id: String(waiting.id), name: String(waiting.name) };
  } else {
    for (const d of lines) {
      const p = d.payload ?? {};
      const type = String(p.type ?? '');
      if (d.type === 'response_item' && /call$/.test(type)) tools.push(p.name ?? type);
      if (d.type === 'response_item' && type === 'message' && p.role === 'assistant') {
        answer = (p.content ?? []).map((c) => c.text ?? '').join('');
      }
      if (d.type === 'event_msg' && /task_complete|turn_complete|turn_aborted/.test(type)) {
        done = true;
        if (p.last_agent_message) answer = p.last_agent_message;
      }
      if (d.type === 'event_msg' && /task_started|turn_started/.test(type)) {
        done = false;
        prompts++;
      }
    }
  }
  return {
    done,
    question,
    pending,
    denials,
    prompts,
    answer: answer.slice(-3000),
    steps: tools.length,
    tools: toolCounts(tools),
    ...ruleBreaks(tools),
  };
}

/**
 * The tokens a desktop app's chat used, from its own transcript, in the request ledger's shape (#1316) so native and
 * MoPilot runs compare: `in` is input not read from the cache, summed per served model. Claude Code repeats an
 * assistant message's usage on each of its records, so each message id counts once. A Codex rollout keeps a running
 * total; each rise is one request. Null when the transcript has no usage, never zero.
 * @param {'claude' | 'codex'} kind @param {string} text
 * @returns {{ requests: number, tokens: number, byModel: Record<string, { in: number, out: number, cacheRead: number, cacheWrite: number, reasoning: number }> } | null}
 */
export function transcriptUsage(kind, text) {
  /** @type {Record<string, { in: number, out: number, cacheRead: number, cacheWrite: number, reasoning: number }>} */
  const byModel = {};
  const add = (/** @type {string} */ model, /** @type {Record<string, unknown>} */ c) => {
    const m = (byModel[model || '?'] ??= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    for (const k of /** @type {const} */ (['in', 'out', 'cacheRead', 'cacheWrite', 'reasoning'])) {
      const v = c[k];
      if (typeof v === 'number' && Number.isFinite(v)) m[k] += v;
    }
  };
  let requests = 0;
  if (kind === 'claude') {
    const seen = new Set();
    for (const d of parseJsonl(text)) {
      const u = d.type === 'assistant' ? d.message?.usage : null;
      if (!u || seen.has(d.message.id)) continue;
      seen.add(d.message.id);
      requests++;
      add(d.message.model, {
        in: u.input_tokens,
        out: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
        reasoning: u.output_tokens_details?.thinking_tokens,
      });
    }
  } else {
    let model = '';
    /** @type {any} */
    let total = null;
    for (const d of parseJsonl(text)) {
      if (d.type === 'turn_context' && typeof d.payload?.model === 'string') model = d.payload.model;
      const t = d.type === 'event_msg' && d.payload?.type === 'token_count' ? d.payload.info?.total_token_usage : null;
      if (!t || t.total_tokens === total?.total_tokens) continue;
      total = t;
      requests++;
    }
    if (total)
      add(model, {
        in: total.input_tokens - (total.cached_input_tokens ?? 0),
        out: total.output_tokens,
        cacheRead: total.cached_input_tokens,
        cacheWrite: total.cache_write_input_tokens,
        reasoning: total.reasoning_output_tokens,
      });
  }
  if (!requests) return null;
  const tokens = Object.values(byModel).reduce((s, c) => s + c.in + c.out + c.cacheRead + c.cacheWrite, 0);
  return { requests, tokens, byModel };
}

/**
 * A chat's tokens over every transcript file it used (an app that moves a chat to a new file starts that file's count
 * afresh), summed per served model; null when no file has usage.
 * @param {'claude' | 'codex'} kind @param {string[]} texts
 */
export function chatUsage(kind, texts) {
  const all = texts.map((t) => transcriptUsage(kind, t)).filter((u) => u !== null);
  if (!all.length) return null;
  /** @type {Record<string, { in: number, out: number, cacheRead: number, cacheWrite: number, reasoning: number }>} */
  const byModel = {};
  for (const u of all)
    for (const [model, c] of Object.entries(u.byModel)) {
      const m = (byModel[model] ??= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
      for (const k of /** @type {const} */ (['in', 'out', 'cacheRead', 'cacheWrite', 'reasoning'])) m[k] += c[k];
    }
  return {
    requests: all.reduce((n, u) => n + u.requests, 0),
    tokens: all.reduce((n, u) => n + u.tokens, 0),
    byModel,
  };
}

/**
 * The chat's title as the app named it (Claude Code: the last `custom-title` record), so the driver can find the chat
 * in the app's sidebar; null when the transcript has none.
 * @param {string} text
 */
export function transcriptTitle(text) {
  let title = null;
  for (const d of parseJsonl(text))
    if (d.type === 'custom-title' && typeof d.customTitle === 'string' && d.customTitle) title = d.customTitle;
  return title;
}

/**
 * How a desktop app actually ran a chat, from its own transcript: the permission mode (Claude Code's last
 * `permissionMode`; a Codex rollout's approval policy and sandbox, as "never/danger-full-access"), the served model and
 * the effort where the transcript names one. Null fields are unknown.
 * @param {'claude' | 'codex'} kind @param {string} text
 * @returns {{ permission: string | null, model: string | null, effort: string | null }}
 */
export function transcriptSetup(kind, text) {
  /** @type {{ permission: string | null, model: string | null, effort: string | null }} */
  const setup = { permission: null, model: null, effort: null };
  for (const d of parseJsonl(text)) {
    if (kind === 'claude') {
      if (typeof d.permissionMode === 'string') setup.permission = d.permissionMode;
      // "<synthetic>" marks a message the app wrote itself (an error, an interruption), not a served model
      const model = d.type === 'assistant' ? d.message?.model : null;
      if (typeof model === 'string' && !model.startsWith('<')) setup.model = model;
    } else if (d.type === 'turn_context' && d.payload) {
      const p = d.payload;
      if (typeof p.approval_policy === 'string') setup.permission = `${p.approval_policy}/${p.sandbox_policy?.type ?? '?'}`;
      if (typeof p.model === 'string') setup.model = p.model;
      if (typeof p.effort === 'string') setup.effort = p.effort;
    }
  }
  return setup;
}

/** Whether a desktop agent reached for a browser outside the app (Claude in Chrome reaches the account's real Chrome). */
export const reachedOutsideBrowser = (/** @type {Record<string, number>} */ tools) =>
  Object.keys(tools).some((k) => /claude-in-chrome/.test(k));

/**
 * Steps and rule breaks from MoPilot's chat view text: its activity summary lines ("Used 3 steps", "Ran a command").
 * Steps are MoPilot's own step totals, so they do not compare with the desktop arms' tool-call counts.
 * @param {string} mainText
 */
export function readActivity(mainText) {
  // summary lines are short; a long line that happens to start with one of these words is the agent's own text
  const summaries = mainText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length <= 80 && /^(Used|Ran|Read|Edited|Searched|Explored|Called)\b/.test(l));
  let steps = 0;
  for (const l of summaries) steps += Number(/(\d+) steps?/.exec(l)?.[1] ?? 1);
  const breaks = ruleBreaks(summaries);
  // "Ran a command", "Ran 3 commands": not "Ran out of moves" in an answer
  const ranCommand = summaries.some((l) => /^Ran (?:a|an|\d+) (?:shell |terminal )?commands?\b/i.test(l));
  return { summaries, steps, shellUsed: breaks.shellUsed || ranCommand, scriptUsed: breaks.scriptUsed };
}
