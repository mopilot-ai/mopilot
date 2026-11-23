// The Chrome comparison's per-action latency: each browser tool call of a task, read from the harness's own transcript (Claude Code's project JSONL, Codex's rollout JSONL) so every arm is timed by the same yardstick, sorted into navigate / click / type / read / screenshot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The action classes, in the order a tool name or a Codex script is tested against them. */
/** @type {[string, RegExp][]} */
const CLASSES = [
  ['screenshot', /screenshot|screen_?shot|capture/i],
  ['navigate', /navigate|goto|open_?url|createBrowserTab|new_?tab|tabs_create|tab\.open/i],
  ['type', /(?:^|[^a-z])type(?:[^a-z]|$)|fill|form_input|press|keyboard|(?:^|[^a-z])key(?:[^a-z]|$)|send_?keys|upload|select_option/i],
  ['click', /click|tap|double_?click|hover|scroll/i],
  ['read', /read_page|snapshot|page_text|get_text|innerText|domSnapshot|accessibility|find|tabs_context|list_?tabs|console|network/i],
];

/**
 * The action class of a call: a `computer`-style tool's own `action` argument first, then the tool name, then the script a Codex call runs.
 * @param {string} name @param {any} input
 */
export function classify(name, input) {
  const probes = [typeof input?.action === 'string' ? input.action : '', name, typeof input?.code === 'string' ? input.code : ''];
  for (const probe of probes) {
    if (!probe) continue;
    for (const [cls, re] of CLASSES) if (re.test(probe)) return cls;
  }
  return 'other';
}

/** Whether a tool is a browser tool at all (the three controllers' names and Codex's script tool), not the chat's own file or shell tools. */
export const isBrowserTool = (name) => /chrome|browser|cua_repl|playwright|tabs_/i.test(String(name));

/**
 * The browser calls of a Claude Code transcript (JSONL text) between `from` and `to` (ms): the tool_use block's time to its tool_result's.
 * @param {string} text @param {{ from: number, to: number }} o
 */
export function claudeActions(text, { from, to }) {
  /** @type {Map<string, { name: string, input: any, at: number }>} */
  const open = new Map();
  const out = [];
  for (const line of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(e?.timestamp);
    if (!(at >= from && at <= to)) continue;
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (b.type === 'tool_use') open.set(b.id, { name: b.name, input: b.input, at });
      else if (b.type === 'tool_result' && open.has(b.tool_use_id)) {
        const c = /** @type {any} */ (open.get(b.tool_use_id));
        open.delete(b.tool_use_id);
        if (isBrowserTool(c.name))
          out.push({
            tool: c.name,
            action: classify(c.name, c.input),
            ms: at - c.at,
            error: b.is_error === true,
            chars: JSON.stringify(b.content ?? '').length,
          });
      }
    }
  }
  return out;
}

/**
 * The browser calls of a Codex rollout (JSONL text) between `from` and `to` (ms): a function_call's time to its function_call_output's.
 * @param {string} text @param {{ from: number, to: number }} o
 */
export function codexActions(text, { from, to }) {
  /** @type {Map<string, { name: string, input: any, at: number }>} */
  const open = new Map();
  const out = [];
  for (const line of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(e?.timestamp);
    const p = e?.payload;
    if (!(at >= from && at <= to) || !p) continue;
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let input = {};
      if (p.type === 'custom_tool_call') input = { code: String(p.input ?? '') };
      else
        try {
          input = JSON.parse(p.arguments) ?? {};
        } catch {
          input = { code: String(p.arguments ?? '') };
        }
      // a code-mode `exec` call runs MCP tools by name (tools.mcp__…): those are the tools it called
      const inner = [...String(input.code ?? '').matchAll(/\btools\.(mcp__\w+)/g)].map((m) => m[1]);
      const name = inner.length ? inner.join('+') : `${p.namespace ?? ''}${p.name ?? ''}`;
      // a computer-style tool's own action argument, when the script names one
      const action = /\baction:\s*["'](\w+)["']/.exec(String(input.code ?? ''))?.[1];
      open.set(p.call_id, { name, input: inner.length ? { first: inner[0], action } : input, at });
    } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && open.has(p.call_id)) {
      const c = /** @type {any} */ (open.get(p.call_id));
      open.delete(p.call_id);
      const text = JSON.stringify(p.output ?? '');
      if (isBrowserTool(c.name))
        out.push({
          tool: c.name,
          action: classify(c.input.first ?? c.name, c.input.first ? { action: c.input.action } : c.input),
          ms: at - c.at,
          error: /error|timed out|failed/i.test(text.slice(0, 400)),
          chars: text.length,
        });
    }
  }
  return out;
}

/** Transcript files modified at or after `from` (ms) under a folder, searched `depth` levels down. */
function recent(dir, from, depth, suffix) {
  const found = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return found;
  }
  for (const n of names) {
    const f = path.join(dir, n);
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    if (st.isDirectory() && depth > 0) found.push(...recent(f, from, depth - 1, suffix));
    else if (st.isFile() && n.endsWith(suffix) && st.mtimeMs >= from) found.push(f);
  }
  return found;
}

/**
 * The browser calls a harness's chats made between `from` and `to` (ms), from every transcript touched since `from`.
 * Claude Code: <home>/.claude/projects/<cwd>/<session>.jsonl; Codex: <home>/.codex/sessions/Y/M/D/rollout-*.jsonl.
 * @param {string} harness @param {{ from: number, to: number, home?: string }} o
 */
export function collectActions(harness, { from, to, home = os.homedir() }) {
  // a transcript that cannot be read now (rotated, unreadable) counts nothing rather than failing the task
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  if (harness === 'claude')
    return recent(path.join(home, '.claude', 'projects'), from, 1, '.jsonl').flatMap((f) => claudeActions(read(f), { from, to }));
  if (harness === 'codex')
    return recent(path.join(home, '.codex', 'sessions'), from, 3, '.jsonl').flatMap((f) => codexActions(read(f), { from, to }));
  return [];
}

/** The median of a list that has values. */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Per arm, harness and action class: how many calls, their median and slowest time (ms), and how many returned an error.
 * @param {{ arm: string, harness: string, actions?: { action: string, ms: number, error: boolean }[] }[]} runs
 */
export function summarizeActions(runs) {
  /** @type {Map<string, { arm: string, harness: string, action: string, ms: number[], errors: number }>} */
  const groups = new Map();
  for (const r of runs)
    for (const a of r.actions ?? []) {
      const key = `${r.arm}|${r.harness}|${a.action}`;
      const g = groups.get(key) ?? { arm: r.arm, harness: r.harness, action: a.action, ms: [], errors: 0 };
      g.ms.push(a.ms);
      if (a.error) g.errors++;
      groups.set(key, g);
    }
  return [...groups.values()].map((g) => ({
    arm: g.arm,
    harness: g.harness,
    action: g.action,
    n: g.ms.length,
    medianMs: median(g.ms),
    maxMs: Math.max(...g.ms),
    errors: g.errors,
  }));
}

/** The action summary as a Markdown table. */
export function actionTable(rows) {
  const head = '| Arm | Harness | Action | Calls | Median ms | Max ms | Errors |\n| --- | --- | --- | --- | --- | --- | --- |';
  return [
    head,
    ...rows.map(
      (r) => `| ${r.arm} | ${r.harness} | ${r.action} | ${r.n} | ${Math.round(r.medianMs)} | ${Math.round(r.maxMs)} | ${r.errors} |`,
    ),
  ].join('\n');
}
