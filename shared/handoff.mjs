// The handoff record of a mid-chat harness switch (design §05): the <sage-handoff> block that goes
// ahead of the user's next message on the new segment. Main writes it (electron/session/switch.cjs)
// from the chat's history rendered as thread turns. Pure.
import { parseUserText, prettyCommand } from './userText.mjs';
import { prefixUnits } from './textPrefix.mjs';
import { COMPACT_COMMAND } from './compaction.mjs';

import { audioInputLines, audioHandoffText } from './audioHandoff.mjs';
import { ownTable } from './ownTable.mjs';
export const HARNESS_LABEL = ownTable({ codex: 'Codex', claude: 'Claude Code' });
export const HANDOFF_LABEL = { auto: 'Automatic handoff', summary: 'Summary handoff', workspace: 'Workspace only', delta: 'Caught up' };

/** The divider when a chat comes back to a harness it used before (COPY.switchSheet.dividerBack). */
export const DIVIDER_BACK = 'Back on {label}';

export const estimateTokens = (text) => Math.ceil(text.length / 3);
const DEFAULT_WINDOW = 200_000;
/** The handoff may use at most this share of the target model's context window. */
const BUDGET_SHARE = 0.4;

/** The target model's context window as far as the picker knows it. */
export function targetWindow(model) {
  if (/\[1m\]/i.test(model)) return 1_000_000;
  return DEFAULT_WINDOW;
}

export const handoffBudget = (model) => Math.floor(targetWindow(model) * BUDGET_SHARE);

export const SUMMARY_PROMPT =
  "Write a handoff note for another coding agent who will take over this conversation. Do not use any tools. Cover: the user's goal, decisions made and why, the current state (what is done and what is not), files changed, open questions, and the next steps. Be concise and specific; use Markdown headings.";

export function dividerText(from, to, modelLabel, mode, tokens, fromLabel = HARNESS_LABEL[from], toLabel = HARNESS_LABEL[to]) {
  return `${fromLabel} → ${toLabel}${modelLabel ? ` · ${modelLabel}` : ''}`;
}

export function backDivider(label, n, other) {
  return DIVIDER_BACK.replace('{label}', label);
}

/* ------------------------------------------------------------------ */
/* the conversation, as text                                           */
/* ------------------------------------------------------------------ */
const userText = (t) =>
  t.items
    .filter((i) => i.type === 'userMessage')
    .map((i) => {
      const p = parseUserText(
        (i.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n'),
      );
      const sel = p.selections.map((x) => `[selected text] ${x}`);
      // the page the message was sent from (Chrome's side panel): the next harness needs it as much as this one did
      const tab = p.chromeTab ? [`[Chrome tab: ${p.chromeTab}]`] : [];
      return [...sel, p.text, ...tab, ...audioInputLines(i.content)].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');

const finalText = (t) => (t.items.filter((i) => i.type === 'agentMessage').pop()?.text ?? '').trim();
export const turnMessageTexts = (turn) => ({ user: userText(turn), reply: finalText(turn) });

/** The last `lines` lines, found from the end: a command's output can be far longer than what is kept of it. */
const tail = (s, lines) => {
  const text = s.endsWith('\n') ? s.slice(0, -1) : s;
  let at = text.length;
  for (let i = 0; i < lines; i++) {
    if (at === 0) return text;
    at = text.lastIndexOf('\n', at - 1);
    if (at < 0) return text;
  }
  return `…\n${text.slice(at + 1)}`;
};

function diffStat(diff, kind) {
  const text = diff ?? '';
  const patch = /^(?:@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|--- [^\n]+\n\+\+\+ [^\n]+|diff --git (?:a\/|"))/.test(text);
  if ((kind === 'add' || kind === 'delete') && !patch) {
    const count = text ? text.replace(/\n$/, '').split('\n').length : 0;
    return kind === 'add' ? `+${count} −0` : `+0 −${count}`;
  }
  let a = 0;
  let r = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const l of (diff ?? '').split('\n')) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
    if (hunk) {
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      continue;
    }
    const inHunk = oldRemaining > 0 || newRemaining > 0;
    if (l.startsWith('diff --git ')) {
      oldRemaining = 0;
      newRemaining = 0;
    } else if (l.startsWith('+') && (inHunk || !l.startsWith('+++ '))) {
      a++;
      newRemaining--;
    } else if (l.startsWith('-') && (inHunk || !l.startsWith('--- '))) {
      r++;
      oldRemaining--;
    } else if (inHunk && l.startsWith(' ')) {
      oldRemaining--;
      newRemaining--;
    }
  }
  return `+${a} −${r}`;
}

/**
 * One line per tool step; command output keeps its last lines when `full`. A tool call's arguments and result stay out
 * (page addresses, tokens, page text and grants: CM-S01), so the preface (RECORD_RULE) sends the next agent back to the
 * source for what the record does not state.
 */
function stepLines(t, full) {
  const out = [];
  for (const it of t.items) {
    switch (it.type) {
      case 'commandExecution': {
        const acts = it.commandActions ?? [];
        if (acts.length && acts.every((a) => ['read', 'search', 'listFiles'].includes(a.type))) {
          for (const a of acts)
            out.push(
              a.type === 'read'
                ? `- Read ${a.path ?? a.name}`
                : a.type === 'search'
                  ? `- Searched for ${a.query ?? a.command}${a.path ? ` in ${a.path}` : ''}`
                  : `- Listed ${a.path ?? 'files'}`,
            );
          break;
        }
        out.push(
          `- Ran \`${prefixUnits(prettyCommand(it.command ?? '').split('\n')[0], 200)}\`${it.exitCode != null ? ` → exit ${it.exitCode}` : ''}${it.status === 'declined' ? ' (declined by user)' : ''}`,
        );
        if (full && it.aggregatedOutput?.trim()) out.push(tail(it.aggregatedOutput, 12).replace(/^/gm, '    '));
        break;
      }
      case 'fileChange':
        for (const c of it.changes ?? []) {
          const kind = c.kind?.type ?? c.kind;
          out.push(
            `- ${it.status === 'declined' ? 'Declined edit to' : it.status === 'failed' ? 'Failed edit to' : kind === 'add' ? 'Created' : kind === 'delete' ? 'Deleted' : 'Edited'} ${c.path} (${diffStat(c.diff, kind)})`,
          );
        }
        break;
      case 'webSearch':
        out.push(`- Web: ${it.query || it.action?.url || 'search'}`);
        break;
      case 'mcpToolCall':
        out.push(`- Tool ${[it.server, it.tool].filter(Boolean).join(' · ')}`);
        break;
      case 'collabAgentToolCall':
        out.push(`- Sub-agent: ${it.prompt ?? it.tool}`);
        break;
      case 'statusNote':
        if (it.kind === 'task') out.push(`- (${it.text})`);
        break;
      case 'contextCompaction':
        // the summary is the only record of the turns before it (shared/compaction.mjs), so it is handed over in full
        if (full && it.summary) out.push('- (context compacted; summary:)', indent(it.summary));
        else out.push(COMPACTED_STEP);
        break;
    }
  }
  return out;
}

const COMPACTED_STEP = '- (context compacted)';
const indent = (text) => text.replace(/^/gm, '    ');

/**
 * The one line a turn that only compacted the context reads as (Codex's compaction turn, a /compact command that got no
 * reply), or null for any other turn: as an exchange it would read as an empty prompt answered by nothing.
 */
function compactionLine(t, user, fin) {
  const compacted = t.items.some((i) => i.type === 'contextCompaction');
  if (fin || (user ? !COMPACT_COMMAND.test(user) : !compacted)) return null;
  // a message sent while it ran is a request of its own, not the command's instructions
  if (t.items.filter((i) => i.type === 'userMessage').length > 1) return null;
  if (stepLines(t, false).some((l) => l !== COMPACTED_STEP)) return null;
  const ran = user ? `user ran ${prefixUnits(user.replace(/\s+/g, ' '), 160)}` : '';
  // a transcript that keeps no compaction record (Claude Code's, read back) only shows that the command ran
  if (!compacted) return `(${ran} to compact the context)`;
  const done =
    t.status === 'inProgress'
      ? 'context compaction still running'
      : t.status === 'failed' || t.status === 'interrupted'
        ? 'context compaction did not finish'
        : 'context compacted';
  return `(${[ran, done].filter(Boolean).join('; ')})`;
}

/** What both renderings of a turn start from, so a turn rendered both ways reads its messages once. */
function turnFacts(t) {
  const user = userText(t);
  const fin = finalText(t);
  return { user, fin, compaction: compactionLine(t, user, fin) };
}

function renderTurn(t, n, full, { user, fin, compaction }) {
  if (compaction) {
    const summaries = t.items.filter((i) => i.type === 'contextCompaction' && i.summary).map((i) => indent(i.summary));
    return full ? [`### Turn ${n}`, compaction, ...summaries].join('\n') : `- Turn ${n}: ${compaction}`;
  }
  if (!full)
    return `- Turn ${n}: ${user ? `user asked "${prefixUnits(user.replace(/\s+/g, ' '), 160)}"` : 'continued on its own'}${fin ? ` → ${prefixUnits(fin.replace(/\s+/g, ' '), 220)}` : ''}`;
  const steps = stepLines(t, true);
  return [
    `### Turn ${n}`,
    user ? `User: ${user}` : 'User: (no message; the agent continued on its own)',
    ...(steps.length ? ['Steps:', ...steps] : []),
    fin ? `Assistant: ${fin}` : 'Assistant: (no reply)',
  ].join('\n');
}

const CONDENSED_HEADING = 'Earlier turns (condensed):';
/** What joining the parts adds to one more part. */
const PART_GAP = 2;

/**
 * The conversation within a token budget: newest turns verbatim, older ones as one-liners. Main runs this on its own thread
 * when a message goes out, so a chat's length must not hold it: each turn is rendered at most once each way, and verbatim only
 * from the newest back until those turns alone are over the budget, so that cost is bounded by the budget.
 */
export function renderConversation(turns, budgetTokens, firstNumber = 1) {
  const n = turns.length;
  const limit = budgetTokens * 3;
  const facts = new Array(n);
  const factsOf = (i) => (facts[i] ??= turnFacts(turns[i]));
  /** verbatim turns, newest first, and their length with the gaps between them */
  const recent = [];
  let recentLength = 0;
  /** one-liners, oldest first, and their length with a gap after each */
  const older = [];
  let olderLength = 0;
  /**
   * Renders up to the newest `keep` turns, and says whether all of them are rendered: once those rendered are over the limit,
   * a keep with more of them cannot fit, and nothing older is rendered for it. The last keep is taken whatever its size.
   */
  const renderRecent = (keep, always) => {
    while (recent.length < keep && (always || recentLength <= limit)) {
      const i = n - 1 - recent.length;
      const text = renderTurn(turns[i], firstNumber + i, true, factsOf(i));
      recentLength += text.length + (recent.length ? PART_GAP : 0);
      recent.push(text);
    }
    return recent.length >= keep;
  };
  for (let keep = n; ; keep = Math.max(1, Math.floor(keep * 0.7))) {
    const last = keep <= 1;
    if (!renderRecent(keep, last)) continue;
    const count = n - keep;
    while (older.length < count) {
      const i = older.length;
      const text = renderTurn(turns[i], firstNumber + i, false, factsOf(i));
      olderLength += text.length + PART_GAP;
      older.push(text);
    }
    const verbatim = recent.slice(0, keep).reverse();
    const verbatimLength = verbatim.reduce((sum, text) => sum + text.length + PART_GAP, -PART_GAP);
    // the heading and its gap, the one-liners with theirs, and the empty part with its gap before the verbatim turns
    const length = (count ? CONDENSED_HEADING.length + PART_GAP + olderLength + PART_GAP : 0) + verbatimLength;
    if (last || Math.ceil(length / 3) <= budgetTokens) {
      const parts = [...(count ? [CONDENSED_HEADING, ...older, ''] : []), ...verbatim];
      return { text: parts.join('\n\n'), condensed: count };
    }
  }
}

function planText(turns) {
  const plan = [...turns].reverse().find((t) => t.plan?.steps?.length)?.plan;
  if (!plan) return '';
  return [
    '## Current plan',
    ...plan.steps.map((s) => `- [${s.status === 'completed' ? 'x' : s.status === 'inProgress' ? '~' : ' '}] ${s.step}`),
  ].join('\n');
}

/**
 * How the new agent treats the record (#1381 stab1): it leaves tool results out, so a fact it does not state is read again
 * from its source rather than made up, and the earlier agent's findings stand unless that source says otherwise.
 */
const RECORD_RULE =
  "The record leaves out what browser, desktop and other app tools returned: read again from its source anything you need that the record doesn't state (an ID, number or date), never guess it, and keep the earlier agent's findings unless the source contradicts them.";

/**
 * The <sage-handoff> block placed before the user's next message on the new segment.
 * @param o.turns the turns to hand over (the chat's history from `since` on)
 * @param o.note the source harness's own handoff note (mode 'summary')
 * @param [o.fromLabel] the source harness's name when it is not a first-tier one (a basic harness)
 * @param o.workspace the "## Workspace" section
 */
export function composeHandoff(o) {
  const name = o.fromLabel ?? HARNESS_LABEL[o.from];
  const who = `${name}${o.fromModel ? ` (${o.fromModel})` : ''}`;
  const parts = [];
  if (o.mode === 'delta')
    parts.push(
      `You worked on this conversation earlier. Since then another agent, ${who}, handled the turns below. Catch up on them, then answer the user's message that follows this block. Files on disk are the source of truth; re-read files before editing them. ${RECORD_RULE}`,
    );
  else
    parts.push(
      `You are taking over this conversation from another coding agent, ${who}. Below is a handoff record. Files on disk are the source of truth; re-read files before editing them.${o.mode === 'auto' ? ` ${RECORD_RULE}` : ''} Continue by answering the user's message that follows this block.`,
    );
  if (o.mode === 'summary') {
    if (!o.note) throw new Error('The summary came back empty');
    parts.push(`## Handoff note from ${name}`, o.note);
  } else if (o.mode !== 'workspace' && o.turns.length) {
    const conv = renderConversation(o.turns, handoffBudget(o.targetModel) - 2_000, o.since + 1);
    parts.push(`## Conversation${o.mode === 'delta' ? ' since you last worked on it' : ' so far'}`, conv.text);
  }
  const audio = o.mode === 'workspace' ? '' : audioHandoffText(o.turns);
  if (audio) parts.push(audio);
  const plan = planText(o.turns);
  if (plan && o.mode !== 'summary') parts.push(plan);
  parts.push(o.workspace);
  if (o.held) parts.push(o.held);
  // quoted text (turns, the note, file names) cannot close the block early: the reader stops at the first close
  const body = parts.join('\n\n').replace(/<\/(sage-handoff)/gi, '<\\/$1');
  return `<sage-handoff from="${name}" mode="${o.mode}">\n${body}\n</sage-handoff>`;
}

/** The "## Workspace" section: the directory, its branch and uncommitted changes. */
export function workspaceText(cwd, info, status) {
  const lines = [`## Workspace`, `Directory: ${cwd}`];
  if (info) lines.push(`Branch: ${info.branch}`);
  const files = status?.files ?? [];
  if (files.length) {
    lines.push('Uncommitted changes (git status):');
    for (const f of files.slice(0, 40)) lines.push(`  ${f.code} ${f.path} (+${f.added} −${f.removed})`);
    if (files.length > 40) lines.push(`  … ${files.length - 40} more`);
  } else if (info) lines.push(status ? 'No uncommitted changes.' : 'Could not read uncommitted changes.');
  return lines.join('\n');
}

/** At most this many held targets are listed; the rest are counted. */
const HELD_MAX = 20;

const heldLine = (l) => {
  if (l.surface === 'chrome') return "Your Chrome: this chat's tab group (the Your Chrome tab list shows its tabs)";
  const extra = [l.mark ? `marked ${l.mark}` : '', l.takenOver || l.userTook ? 'taken over by the user' : ''].filter(Boolean);
  const who = (l.openedBy ?? l.origin) === 'agent' ? 'opened by the agent' : "the user's";
  const rest = `${l.site || 'no site loaded'}, ${who}${extra.length ? `, ${extra.join(', ')}` : ''}`;
  // the user's Chrome over MoPilot's extension or relay: Chrome's own tab id, which its Chrome tools take
  if (l.surface === 'chromeTab') return `Your Chrome tab ${l.id} (in this chat's MoPilot tab group): ${rest}`;
  if (l.surface === 'desktop') return 'The Mac: this chat holds the computer-use desktop lock';
  if (l.surface === 'app')
    return `The app ${l.label || l.id}: this chat holds its computer-use lock${l.takenOver ? ' (the user took it over)' : ''}`;
  return `Built-in browser ${l.popup ? 'popup' : 'tab'} ${l.id}: ${rest}`;
};

/**
 * How a harness reaches a held in-app browser tab by its pane id, where its own tools name tabs otherwise: the Codex
 * Browser plugin's in-app browser ("iab") lists the chat's pane tabs under its own ids, each with the pane id as
 * providerTabId (browser/iabBackend.cjs serialize).
 */
const HELD_HOW = {
  codex:
    'With the Browser plugin\'s in-app browser ("iab"), call tabs.list(), take the tab whose providerTabId is that id, and pass its own id to tabs.get(); don\'t open a new tab for a page listed here.',
};

/**
 * The "## Tabs and targets this chat holds" section (TargetLeases): what stays with the chat across the switch, so the
 * new harness knows about it, or '' when it holds nothing. Tabs are named by id and site, never by path or query.
 * @param {Array<{ surface: string, id: string, origin: string, openedBy?: string, mark?: string | null,
 *                 takenOver?: boolean, userTook?: boolean, site?: string | null, label?: string, popup?: boolean }> | null | undefined} leases
 * @param {string | null} [harness] the harness the chat switches to: how it reaches a held tab, when that differs (HELD_HOW)
 */
export function heldText(leases, harness = null) {
  if (!leases?.length) return '';
  const lines = [
    '## Tabs and targets this chat holds',
    "They stay with this chat after the switch. Use a tab by its id with its browser's tools (the built-in browser's, or the Chrome tools for a Your Chrome tab), and read it before acting on it.",
    ...(harness && Object.hasOwn(HELD_HOW, harness) && leases.some((l) => l.surface === 'iab') ? [HELD_HOW[harness]] : []),
    ...leases.slice(0, HELD_MAX).map((l) => `- ${heldLine(l)}`),
  ];
  if (leases.length > HELD_MAX) lines.push(`- … ${leases.length - HELD_MAX} more`);
  return lines.join('\n');
}

/**
 * Each segment's slice of its native history, for a chat that spans several native sessions: a
 * session may carry more than one segment (a switch back to it), each taking the turns after the
 * previous one's.
 * @param segs segments with `nativeId` and `count` (null: to the end)
 * @param history Map nativeId -> that session's turns
 */
export function sliceSegments(segs, history, keyOf = (seg) => seg.nativeId) {
  const offset = new Map();
  return segs.map((seg) => {
    const key = keyOf(seg);
    const h = history.get(key) ?? [];
    const off = offset.get(key) ?? 0;
    const slice = h.slice(off, seg.count == null ? undefined : off + seg.count);
    offset.set(key, off + slice.length);
    return slice;
  });
}

/** How each first-tier harness takes a goal again after a switch: Codex as an option, Claude Code as its own /goal command. */
const GOAL_AGAIN = {
  codex: (objective) => ({ text: objective, opts: { goal: objective } }),
  claude: (objective) => ({ text: `/goal ${objective}`, opts: {} }),
};

/** The message that sets the goal again on the harness a chat switched to (a switch only goes to a first-tier harness). */
export function goalAgain(to, objective) {
  if (!Object.hasOwn(GOAL_AGAIN, to)) throw new Error(`There is no way to set a goal again on ${to}`);
  return GOAL_AGAIN[to](objective);
}
