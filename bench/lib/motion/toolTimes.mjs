// Motion bench per-action wall time (#3810): tool calls with their start and end times read from a Claude Code or Codex transcript, sorted into click, type, scroll and screenshot, and their quantiles.
import { spread } from './stats.mjs';

/** @typedef {'click' | 'type' | 'scroll' | 'screenshot' | 'other'} ActionKind */
/** @typedef {{ kind: ActionKind, name: string, startMs: number, endMs: number | null }} ToolCall wall-clock ms */

/** What a tool call does, from its name and the action it was given: a screenshot or state read, a scroll, typing or keys, a click or move. */
export function classifyAction(/** @type {string} */ name, /** @type {unknown} */ input) {
  const action = input && typeof input === 'object' && 'action' in input ? String(/** @type {any} */ (input).action) : '';
  const text = `${name} ${action}`.toLowerCase();
  if (/screenshot|screen_?shot|capture|get_app_state|snapshot|read_page|zoom/.test(text)) return /** @type {ActionKind} */ ('screenshot');
  if (/scroll|wheel/.test(text)) return 'scroll';
  if (/type|key|text|paste|fill|input/.test(text)) return 'type';
  if (/click|tap|press|mouse|drag|move|hover/.test(text)) return 'click';
  return 'other';
}

const lines = (/** @type {string} */ text) =>
  text
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        // a partly written last line
        return [];
      }
    });
const when = (/** @type {any} */ d) => (typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : Number.NaN);

/**
 * Tool calls with start and end: a Claude Code call starts at its assistant record and ends at the user record that
 * carries its result; a Codex call at its function call and the output with the same call id. A call with no result has `endMs: null`.
 * @param {'claude' | 'codex'} kind @param {string} text
 * @returns {ToolCall[]}
 */
export function toolCallTimes(kind, text) {
  /** @type {Map<string, ToolCall>} */
  const open = new Map();
  /** @type {ToolCall[]} */
  const calls = [];
  for (const d of lines(text)) {
    const at = when(d);
    if (Number.isNaN(at)) continue;
    if (kind === 'claude') {
      for (const c of Array.isArray(d.message?.content) ? d.message.content : []) {
        if (c.type === 'tool_use') {
          const call = { kind: classifyAction(c.name, c.input), name: c.name, startMs: at, endMs: null };
          calls.push(call);
          open.set(c.id, call);
        } else if (c.type === 'tool_result' && open.has(c.tool_use_id)) /** @type {ToolCall} */ (open.get(c.tool_use_id)).endMs = at;
      }
    } else if (d.type === 'response_item') {
      const p = d.payload ?? {};
      if (/call$/.test(String(p.type)) && p.call_id) {
        let input = {};
        try {
          input = JSON.parse(p.arguments ?? '{}');
        } catch {
          // arguments that are not JSON classify by name only
        }
        const call = { kind: classifyAction(String(p.name ?? p.type), input), name: String(p.name ?? p.type), startMs: at, endMs: null };
        calls.push(call);
        open.set(p.call_id, call);
      } else if (/output$/.test(String(p.type)) && open.has(p.call_id)) /** @type {ToolCall} */ (open.get(p.call_id)).endMs = at;
    }
  }
  return calls;
}

/** Wall time per action kind over finished calls: count, p50, p95, max (ms). */
export function actionStats(/** @type {ToolCall[]} */ calls) {
  /** @type {Record<string, ReturnType<typeof spread>>} */
  const out = {};
  for (const kind of /** @type {ActionKind[]} */ (['click', 'type', 'scroll', 'screenshot', 'other'])) {
    out[kind] = spread(calls.filter((c) => c.kind === kind && c.endMs !== null).map((c) => /** @type {number} */ (c.endMs) - c.startMs));
  }
  return out;
}
