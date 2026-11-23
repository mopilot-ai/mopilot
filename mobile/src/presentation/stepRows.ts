// What a step row says beyond its line: how far it got (running, failed), what it read or ran, the screenshot it took and where it worked; and which of the agent's own bookkeeping steps the transcript leaves out or folds.
import { stateOfCall, toolLine } from '../../../electron/capabilities/browser/chromePanelToolLines.cjs';
import type { Data, Row } from './thread';

/** How far a step got; a step that says neither ran to the end. */
export type StepState = 'running' | 'failed';
/** What a step carries beyond its line, as the computer's saved rows and live items say it. */
export type StepExtras = { state?: StepState; detail?: string; thumbnail?: string; surface?: string; callId?: string };

/** A picture the phone draws inline: only an image the computer already embedded, never a link it would fetch. */
const PICTURE = /^data:image\/(?:png|jpeg|webp|gif);base64,/;
/** The longest picture kept (the computer sends at most this much for a step's screenshot). */
const MOST_PICTURE = 400_000;

const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
/** The longest call id steps.thumbnail takes (a phone row id is a JSON list that ends with the item id). */
const MOST_CALL_ID = 2048;

/** The call a step row or live item stands for, as steps.thumbnail names it; none when the item has no usable id. */
export function callIdOf(item: Data): { callId?: string } {
  const id = typeof item.id === 'number' ? String(item.id) : text(item.id);
  return id && id.length <= MOST_CALL_ID ? { callId: id } : {};
}

/** A saved step row's extras: what the computer sent, where it is the shape the phone draws. */
export function savedExtras(item: Data): StepExtras {
  const state = item.state === 'running' || item.state === 'failed' ? item.state : undefined;
  const picture = text(item.thumbnail);
  return {
    ...(state ? { state } : {}),
    ...(text(item.detail) ? { detail: text(item.detail) } : {}),
    ...(picture && PICTURE.test(picture) && picture.length <= MOST_PICTURE ? { thumbnail: picture } : {}),
    ...(text(item.surface) ? { surface: text(item.surface) } : {}),
    ...callIdOf(item),
  };
}

const TOOL_CALLS = new Set(['mcpToolCall', 'dynamicToolCall']);

/**
 * A live item's line and state, worded as the computer's saved rows word the same call once the turn is saved: a tool
 * call reads "Clicked", "Opened example.com", never the item's type.
 */
export function liveStep(item: Data, fallback: string): { text: string; state?: StepState } {
  const state = stateOfCall(item);
  const extras = state === 'done' ? {} : { state };
  if (!TOOL_CALLS.has(String(item.type))) return { text: fallback, ...extras };
  try {
    return { text: toolLine(item, state), ...extras };
  } catch {
    // a line the phone cannot word (a runtime missing what the computer's wording uses: only a named tool's) reads as the tool's name
    return { text: String(item.tool), ...extras };
  }
}

/** The agent's own bookkeeping, which Claude's transcript does not show: its task list, its wrap-up and a skill it loaded. */
const HIDDEN = /^(?:Updat(?:ed|ing) task list|Wrapp(?:ed|ing) up|Us(?:ed|ing) Skill)$/;
/** Loading more tools ("Used ToolSearch", "Used browser_more_tools"), whichever way the harness named the tool. */
const LOADING = /^(Used|Using) (?:\S*\/)?(?:ToolSearch|[\w-]*more_tools)$/;

const isStep = (r: Row) => r.role === 'step' || r.role === 'live';

/**
 * The rows as the transcript shows them: the agent's bookkeeping steps are left out (a failed one stays, so a failure is
 * never hidden) and loading more tools reads "Loaded tools", once for a run of them.
 */
export function tidySteps<R extends Row>(rows: R[]): R[] {
  const out: R[] = [];
  for (const r of rows) {
    if (!isStep(r)) {
      out.push(r);
      continue;
    }
    if (HIDDEN.test(r.text)) continue;
    const loading = LOADING.exec(r.text);
    if (!loading) {
      out.push(r);
      continue;
    }
    const line = loading[1] === 'Using' ? 'Loading tools' : 'Loaded tools';
    const last = out.at(-1);
    // a run of loads reads as one; the latest one says whether it still loads
    if (last && isStep(last) && /^Load(?:ed|ing) tools$/.test(last.text)) out[out.length - 1] = { ...last, text: line };
    else out.push({ ...r, text: line });
  }
  return out;
}
