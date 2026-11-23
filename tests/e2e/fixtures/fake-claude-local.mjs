// The fake Claude CLI's local commands, read the way the real CLI reads them: a message runs as the CLI's own command
// when its string content, or its last text block, starts with "/", untrimmed (CLI 2.1.311). /clear empties the
// conversation and the model never sees it.

/**
 * Runs `msg` as a local command when the real CLI would; true when it did (the turn is over).
 * @param {any} msg the stream-json user line
 * @param {{ log: (e: object) => void, init: () => void, send: (m: object) => void, result: Function, sessionId: string, uuid: () => string }} cli
 */
export function runLocalCommand(msg, cli) {
  const c = msg.message?.content;
  const last = Array.isArray(c) ? c.at(-1) : null;
  const text = typeof c === 'string' ? c : last?.type === 'text' ? last.text : null;
  if (text === null || !/^\/clear(?:\s|$)/.test(text)) return false;
  cli.log({ kind: 'local', command: 'clear' });
  cli.init();
  cli.send({
    type: 'system',
    subtype: 'local_command_output',
    content: '',
    parent_tool_use_id: null,
    session_id: cli.sessionId,
    uuid: cli.uuid(),
  });
  cli.result(Date.now(), false, '', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  return true;
}
