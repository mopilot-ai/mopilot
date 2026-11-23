// Sanitized shape of two background completions each receiving a native Claude session-limit error.
export const CLAUDE_LIMIT_TEXT = "You've hit your session limit · resets 3:30am (America/Los_Angeles)";

export function claudeLimitNotifications() {
  const messages = [];
  const add = (type, extra) => {
    const uuid = `00000000-0000-4000-8000-${String(messages.length + 1).padStart(12, '0')}`;
    messages.push({
      type,
      uuid,
      parentUuid: messages.at(-1)?.uuid ?? null,
      timestamp: new Date(Date.UTC(2026, 9, 24, 9, 37, messages.length * 10)).toISOString(),
      ...extra,
    });
  };
  add('user', { message: { role: 'user', content: 'Run the targeted checks' } });
  add('assistant', {
    message: { id: 'reply', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The checks are running.' }] },
  });
  for (const task of ['coverage', 'wait-for-coverage']) {
    add('user', {
      message: {
        role: 'user',
        content: `<task-notification><task-id>${task}</task-id><status>completed</status><summary>${task} completed</summary></task-notification>`,
      },
    });
    add('assistant', {
      error: 'rate_limit',
      isApiErrorMessage: true,
      message: {
        id: task,
        type: 'message',
        role: 'assistant',
        model: '<synthetic>',
        stop_reason: 'stop_sequence',
        stop_sequence: '',
        content: [{ type: 'text', text: CLAUDE_LIMIT_TEXT }],
      },
    });
  }
  return messages;
}
