// The handoff text of a continue on another Host (docs: design/host/index.html, package 3.2): the chat as a Host's session stream recorded it, turned into the thread turns the harness-switch handoff (shared/handoff.mjs) already renders, and composed with it unchanged. Pure.
import { composeHandoff, estimateTokens } from '../handoff.mjs';
import { codeLines } from './codeTransfer.mjs';
import { compactionStep, isCompaction, isToolUpdate, mergeToolUpdate, stepOf } from './hostToolSteps.mjs';

/** The line a record carries when its conversation could not be read in full, so the next agent says what it is unsure of instead of guessing. */
export const PARTIAL_NOTE = 'Note: this record may be missing earlier turns; the conversation could not be read in full.';

/** What a record handed over from the host before reads as, in front of the user's message it came with. */
const EARLIER = '(Earlier in this conversation, handed over from another host:)';

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a user item says about the files that came with it: a record carries no file contents, so the count is all it can say. @param {any} item */
function attachmentLine(item) {
  const n = Array.isArray(item.attachments) ? item.attachments.length : 0;
  return n > 0 ? `[${n} attached file${n === 1 ? '' : 's'}, not carried over]` : '';
}

/**
 * The turns of a chat from the finished items a Host's session stream holds (`{ t: 'user' | 'assistant' | 'handoff', turnId, text, ... }`), oldest first: one turn per turn id, in order of first appearance. An item of a kind
 * this app does not know, or one that is not an object, is skipped (an older or newer Host); a turn that ended in an error or a stop says so in its status.
 * @param {unknown} items
 */
export function turnsFromHostItems(items) {
  /** @type {Map<string, { id: string, status: string, items: object[], error?: { message: string } }>} */
  const turns = new Map();
  /** @param {string} id */
  const turn = (id) => {
    let t = turns.get(id);
    if (!t) turns.set(id, (t = { id, status: 'completed', items: [] }));
    return t;
  };
  /** The merged tool calls and the step each stands for, by turn and call. @type {Map<string, { call: any, step: any }>} */
  const calls = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    if (!isObject(raw)) continue;
    const item = /** @type {any} */ (raw);
    // a tool call the stream recorded (an event of the Host's log, or one the app's mirror kept): a step of its turn, in the order it was told
    const update = item.t === 'event' && item.event?.kind === 'update' ? item.event.update : null;
    const id = typeof item.turnId === 'string' ? item.turnId : typeof item.event?.turnId === 'string' ? item.event.turnId : '';
    if (id && isCompaction(update)) {
      turn(id).items.push(compactionStep());
      continue;
    }
    if (id && isToolUpdate(update)) {
      const key = `${id}\u0000${update.toolCallId}`;
      const known = calls.get(key);
      const merged = mergeToolUpdate(known?.call ?? {}, update);
      const step = stepOf(merged);
      const items = turn(id).items;
      if (known?.step) items.splice(items.indexOf(known.step), 1, ...(step ? [step] : []));
      else if (step) items.push(step);
      calls.set(key, { call: merged, step: step ?? known?.step });
      continue;
    }
    if (!id || (item.t !== 'user' && item.t !== 'assistant' && item.t !== 'handoff')) continue;
    const t = turn(id);
    if (item.t === 'handoff') {
      // the record this chat arrived with: what was said before it came to this host
      if (typeof item.text === 'string' && item.text)
        t.items.push({ type: 'userMessage', content: [{ type: 'text', text: `${EARLIER}\n${item.text}` }] });
    } else if (item.t === 'user') {
      const text = [typeof item.text === 'string' ? item.text : '', attachmentLine(item)].filter(Boolean).join('\n');
      t.items.push({ type: 'userMessage', content: [{ type: 'text', text }] });
    } else {
      t.items.push({ type: 'agentMessage', text: typeof item.text === 'string' ? item.text : '' });
      // the last reply decides how the turn ended
      t.status = item.error ? 'failed' : item.stopReason === 'cancelled' ? 'interrupted' : 'completed';
      if (item.error) t.error = { message: String(item.error) };
      else delete t.error;
    }
  }
  return [...turns.values()];
}

/**
 * The <sage-handoff> block for the new session on the target Host. Of the workspace it says the target's folder and, when the source's repository was read (package 3.5), that repository, branch and how the folder compares with it.
 * @param {object} o
 * @param {object[]} o.turns
 * @param {string} o.fromLabel the harness the conversation ran on
 * @param {string | null} [o.fromModel]
 * @param {string} [o.targetModel]
 * @param {string} o.cwd the folder on the target
 * @param {boolean} o.partial the turns are known to be incomplete
 * @param {{ source: import('./codeTransfer.mjs').RepoFacts | null, target?: import('./codeTransfer.mjs').RepoFacts | null, carried?: number, skipped?: string[] } | null} [o.code] the source's repository and the target folder's, as `repoFacts` reads them, and how many uncommitted files were carried
 */
export function continueHandoff({ turns, fromLabel, fromModel = null, targetModel = '', cwd, partial, code = null }) {
  const workspace = [`## Workspace`, `Directory: ${cwd}`, ...(code ? codeLines(code) : []), ...(partial ? [PARTIAL_NOTE] : [])].join('\n');
  const text = composeHandoff({
    from: '',
    fromLabel: fromLabel || 'the previous agent',
    fromModel,
    mode: 'auto',
    turns: /** @type {any[]} */ (turns),
    since: 0,
    targetModel,
    note: null,
    workspace,
    held: '',
  });
  return { text, tokens: estimateTokens(text) };
}
