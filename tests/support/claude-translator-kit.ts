// A Claude translator that records what it emits, and the assistant, tool call and tool result messages the Claude tests feed it.
import { ClaudeTranslator } from './claude-translate.ts';

export function mk() {
  const events: [string, any][] = [];
  const tr = new ClaudeTranslator('chat', '/repo', (m: string, p: any) => events.push([m, p]));
  const items = (method?: string) => events.filter(([m]) => (method ? m === method : m.startsWith('item/'))).map(([, p]) => p.item);
  const agent = (id = 'ag') =>
    items()
      .filter((i) => i.id === id)
      .at(-1)?.agent;
  const child = (key = 'ag') =>
    events.filter(([m, p]) => m === 'agent/items' && p.agentKey === key).map(([, p]) => JSON.parse(String(p.items)));
  return { tr, events, items, agent, child };
}
export const asst = (content: any[], extra: any = {}) => ({
  type: 'assistant',
  uuid: extra.uuid,
  message: { id: extra.id ?? 'm1', content },
  ...extra,
});
export const use = (name: string, input: any = {}, id = name) => ({ type: 'tool_use', id, name, input });
export const res = (tool_use_id: string, content: any, extra: any = {}) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id, content, is_error: !!extra.is_error }] },
  ...extra,
});
