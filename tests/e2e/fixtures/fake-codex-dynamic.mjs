// Scripted dynamic tool calls retain the real app-server item shape when a native UI journey explicitly requests step records.
import { randomUUID } from 'node:crypto';
import { cuCallsOf } from './fake-cu-calls.mjs';

export const goalRoundOf = (turn) => !turn.items.some((item) => item.type === 'userMessage');

export async function callDynamicTools({ ask, notify, rec, turn, threadId, turnId, text }) {
  const calls = rec.title ? [] : cuCallsOf(text);
  const goalRound = goalRoundOf(turn);
  if (/CONTINUE/.test(text) && !(goalRound && rec.goalRounds >= 2)) return '';
  let output = '';
  for (const [, tool, json] of calls) {
    output += await callDynamicTool({ ask, notify, turn, threadId, turnId, tool, args: JSON.parse(json), steps: text.includes('CUSTEPS') });
  }
  return output;
}

export async function callDynamicTool({ ask, notify, turn, threadId, turnId, tool, args, steps = false, now = Date.now, id = randomUUID }) {
  const callId = id();
  const started = now();
  /** @type {Extract<import('../../../src/protocol/v2/ThreadItem').ThreadItem, { type: 'dynamicToolCall' }> | null} */
  const item = steps
    ? {
        type: 'dynamicToolCall',
        id: callId,
        namespace: null,
        tool,
        arguments: args,
        status: 'inProgress',
        contentItems: null,
        success: null,
        durationMs: null,
      }
    : null;
  if (item) {
    turn.items.push(item);
    notify('item/started', { threadId, turnId, item: { ...item } });
  }
  // A rejected transport ends the scripted turn; no successful completion is invented for that failure.
  const response = await ask('item/tool/call', { threadId, turnId, callId, namespace: null, tool, arguments: args }, 60_000);
  const result = response?.result;
  if (item) {
    item.success = !response?.error && result?.success === true;
    item.status = item.success ? 'completed' : 'failed';
    item.contentItems = result?.contentItems ?? [];
    item.durationMs = now() - started;
    notify('item/completed', { threadId, turnId, item: { ...item } });
  }
  const text = result?.contentItems?.map((content) => (content.type === 'inputImage' ? '<image>' : content.text)).join(' ');
  return ` [cu: ${result?.success === false ? 'error: ' : ''}${text ?? response?.error?.message ?? 'no answer'}]`;
}
