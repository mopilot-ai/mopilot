// Claude Code's MCP end-turn flag: a tool result whose `_meta['claude/endTurn']` is true ends the turn on that result,
// with no message after it (the wrap-up box, as Claude Desktop's). Pure: the key, and whether a transcript line has it.

/** The `_meta` key of an MCP tool result that has Claude Code end the turn on it. */
export const CLAUDE_END_TURN = 'claude/endTurn';

/**
 * Whether a Claude Code transcript line is a tool result that ended its turn (the CLI keeps the result's `_meta` on the
 * line's `mcpMeta`): the turn's last word, as a reply is.
 * @param {any} line
 */
export function endsClaudeTurn(line) {
  return line?.type === 'user' && line.mcpMeta?._meta?.[CLAUDE_END_TURN] === true;
}
