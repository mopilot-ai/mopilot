// Synthetic transcript records for focused replay-index tests and local microbenchmarks.
const timestamp = '2026-01-01T00:00:00.000Z';

export function claudeConversation(turns, tools = 0) {
  const messages = [];
  for (let turn = 0; turn < turns; turn++) {
    messages.push({
      type: 'user',
      uuid: `u${turn}`,
      timestamp,
      message: { content: 'Run the task' },
    });
    for (let item = 0; item < tools; item++) {
      const id = `tool-${turn}-${item}`;
      messages.push(
        {
          type: 'assistant',
          uuid: id,
          timestamp,
          message: {
            id,
            content: [
              {
                type: 'tool_use',
                id,
                name: 'Bash',
                input: { command: 'echo ok' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: `result-${id}`,
          timestamp,
          message: {
            content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
          },
        },
      );
    }
    messages.push({
      type: 'assistant',
      uuid: `a${turn}`,
      timestamp,
      message: { id: `a${turn}`, content: [{ type: 'text', text: 'Done' }] },
    });
  }
  return messages;
}

export function acpConversation(turns, tools = 0) {
  const records = [];
  for (let turn = 0; turn < turns; turn++) {
    const turnId = `turn-${turn}`;
    records.push({
      t: 'user',
      turnId,
      at: 1000,
      user: {
        id: `u${turn}`,
        content: [{ type: 'text', text: 'Run the task' }],
      },
    });
    for (let item = 0; item < tools; item++) {
      const toolCallId = `tool-${turn}-${item}`;
      records.push(
        {
          t: 'update',
          turnId,
          at: 2000,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'Read',
            kind: 'read',
            status: 'in_progress',
          },
        },
        {
          t: 'update',
          turnId,
          at: 2000,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
          },
        },
      );
    }
    for (const sessionUpdate of ['agent_thought_chunk', 'agent_message_chunk'])
      records.push({
        t: 'update',
        turnId,
        at: 2000,
        update: { sessionUpdate, content: { type: 'text', text: 'Done' } },
      });
    records.push({ t: 'end', turnId, at: 3000, stopReason: 'end_turn' });
  }
  return records;
}
