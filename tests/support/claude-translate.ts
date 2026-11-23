// Claude Code translation as a test reads it, on the real core (core/crates/translate/src/claude): what a transcript's messages
// come to as turns, a page or a sub-agent's items, in one call. What main does with a read is electron/platform/claudeHistory.cjs.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { core } = require('../../electron/platform/core.cjs');
const { ClaudeTranslator } = require('../../electron/harness/items/claudeTranslator.cjs');
const { pageOf } = require('../../electron/platform/claudeHistory.cjs');

export { ClaudeTranslator };

type Asked = { liveTail?: boolean; closedTail?: boolean; open?: boolean; limit?: number; before?: string | null; live?: string | null };

const call = (route: string, payload: string) => core().dispatchSync(route, Buffer.from(payload));
const header = (threadId: string, cwd: string) => JSON.stringify({ threadId, cwd, auto: 'test', now: Date.now() });
const lines = (messages: unknown[]) => messages.map((message) => `\n${JSON.stringify(message)}`).join('');

/** A page of what `messages` read as, as JSON bytes, the ids it holds and what main asks of it, with a read that goes at once. */
export function rawPage(messages: unknown[], threadId: string, cwd: string, asked: Asked = {}) {
  const { id } = JSON.parse(String(call('translate.claudeRead', header(threadId, cwd) + lines(messages))));
  try {
    return pageOf(call('translate.claudeSettle', JSON.stringify({ ...asked, id, now: Date.now() })));
  } finally {
    call('translate.claudeRelease', String(id));
  }
}

/** `{ turns, olderCursor, closedTail }`. */
export const transcriptPage = (messages: unknown[], threadId: string, cwd: string, asked: Asked = {}): any =>
  JSON.parse(String(rawPage(messages, threadId, cwd, asked).page));

/** Every turn `messages` read as. */
export const buildTurns = (messages: unknown[], threadId: string, cwd: string, asked: Asked = {}): any[] =>
  transcriptPage(messages, threadId, cwd, asked).turns;

/** What main's claude:subagentItems answers for a stored sub-agent transcript. */
export const subagentReply = (messages: unknown[], threadId: string, cwd: string, settled = false): Buffer =>
  call('translate.claudeAgentItems', JSON.stringify({ threadId, cwd, settled, now: Date.now() }) + lines(messages));

/** A stored sub-agent transcript as its agent page's items. */
export const subagentItems = (messages: unknown[], threadId: string, cwd: string, settled = false): any[] =>
  JSON.parse(String(subagentReply(messages, threadId, cwd, settled))).items;

/** What main's claude:turns answered: the page the window parses, with the saved diffs beside it. */
export const readPage = ({ page, diffs }: { page: Uint8Array; diffs: Record<string, string> }): any => ({
  ...JSON.parse(Buffer.from(page).toString()),
  diffs,
});

/** A page as main's claude:turns answers it. */
export const pageBytes = (
  page: { turns: unknown[]; olderCursor: string | null; closedTail: unknown },
  diffs: Record<string, string> = {},
) => ({
  page: Buffer.from(JSON.stringify(page)),
  diffs,
});

/** What a live translator says of `messages`, in a turn already running: `[method, params]`. */
export function said(messages: unknown[]): [string, any][] {
  const out: [string, any][] = [];
  const tr = new ClaudeTranslator('chat', '/repo', (method: string, params: any) => out.push([method, params]));
  tr.beginTurn('t');
  out.length = 0;
  messages.forEach((message) => tr.onMessage(message));
  tr.close();
  return out;
}

const items = (messages: unknown[]) => said(messages).flatMap(([, params]) => (params.item ? [params.item] : []));

/** The item a native notice comes to, or null. */
export const hookItem = (message: any) => items([{ type: 'system', ...message }]).find((item) => item.type === 'hookPrompt') ?? null;

/** A native notice's text, or null. */
export const hookNote = (message: any): string | null => hookItem({ uuid: 'notice', ...message })?.fragments[0].text ?? null;

const called = (block: any) => ({ type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'tool_use', ...block }] } });

/** The item a tool_use block starts, or undefined for a tool with none. */
export const toolItem = (block: any) => items([called(block)])[0];

/** The item a tool_use block ends as, given its result and the structured `tool_use_result`. */
export function finishedTool(block: any, result: any, structured?: unknown) {
  const answer = {
    type: 'user',
    uuid: 'u',
    tool_use_result: structured,
    message: { content: [{ type: 'tool_result', tool_use_id: block.id, ...result }] },
  };
  return items([called(block), answer]).at(-1);
}

/** What a Bash result says of its run. */
export function bashOutcome(text: string, isError: boolean, structured: unknown) {
  const done = finishedTool({ name: 'Bash', id: 'b', input: {} }, { content: text, is_error: isError }, structured);
  return { output: done.aggregatedOutput, exitCode: done.exitCode };
}

/** What a user message's content comes to in its turn: none for what no one typed. */
export function userContent(content: unknown): any[] {
  return buildTurns([{ type: 'user', uuid: 'u', message: { content } }], 'chat', '/repo')[0]?.items[0]?.content ?? [];
}

/** The line a message makes of itself in a turn, as `{ kind, text, wake }`, or null. */
export function statusLine(message: any) {
  const note = items([{ type: 'user', uuid: 'n', ...message }]).find((item) => item.type === 'statusNote');
  return note ? { kind: note.kind, text: note.text, wake: note.wake } : null;
}

/** A monitor's tick as that line. */
export const monitorWake = ({
  taskId,
  summary,
  description,
  event,
}: {
  taskId?: string;
  summary?: string;
  description?: string;
  event: string;
}) => {
  const tag = (name: string, value?: string) => (value ? `<${name}>${value}</${name}>` : '');
  const body = tag('task-id', taskId) + tag('summary', summary) + tag('description', description) + tag('event', event);
  return statusLine({ origin: { kind: 'task-notification' }, message: { content: `<task-notification>${body}</task-notification>` } })!;
};
