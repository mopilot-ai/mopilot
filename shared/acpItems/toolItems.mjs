// ACP content blocks and merged tool-call state rendered as thread items.
import { contentBlocks, normalizeContentBlock } from '../contentBlocks.mjs';
import { editChanges } from './editChanges.mjs';

/** Text of one ACP content block, as markdown. */
export function blockText(b) {
  b = normalizeContentBlock(b);
  if (!b) return '';
  switch (b.type) {
    case 'text':
      return String(b.text ?? '');
    case 'resource_link':
      return `[${b.title ?? b.name ?? b.uri}](${b.uri})`;
    case 'resource':
      return typeof b.resource?.text === 'string' ? b.resource.text : '';
    case 'image':
      return '[image]';
    default:
      return '';
  }
}
/** Text of a tool call's content list: its content blocks and terminal output. */
export function toolOutput(content) {
  return contentBlocks(content)
    .map((c) => (c?.type === 'content' ? blockText(c.content) : ''))
    .filter(Boolean)
    .join('\n');
}
const commandOf = (tc) => {
  const c = tc.rawInput?.command ?? tc.rawInput?.cmd;
  if (Array.isArray(c)) return c.join(' ');
  if (typeof c === 'string') return c;
  return String(tc.title ?? '');
};
/**
 * The thread item for a tool call (its merged state so far). The kind decides the card: a diff in
 * its content, or an edit whose file it names (editChanges.mjs), makes it an edit, execute a command, read and search the explored-files rows, fetch a
 * web item, everything else a generic tool card.
 */
export function toolItem(tc, cwd) {
  const id = String(tc.toolCallId);
  const title = String(tc.title ?? 'Tool');
  const mcp = /^mcp__(.+?)__(.+)$/.exec(title);
  const browser = mcp && ['mopilot_chrome', 'claude-in-chrome'].includes(mcp[1]);
  const status = tc.status === 'completed' ? 'completed' : tc.status === 'failed' ? 'failed' : 'inProgress';
  const changes = editChanges(tc);
  if (changes.length) return { type: 'fileChange', id, status, changes };
  const path = tc.locations?.[0]?.path ?? tc.rawInput?.path ?? tc.rawInput?.file_path ?? null;
  const cmd = (commandActions, command) => ({
    type: 'commandExecution',
    id,
    command,
    cwd,
    processId: null,
    source: 'agent',
    status,
    commandActions,
    aggregatedOutput: toolOutput(tc.content) || (typeof tc.rawOutput?.output === 'string' ? tc.rawOutput.output : null),
    exitCode: Object.hasOwn(tc.rawOutput ?? {}, 'exitCode')
      ? Number.isSafeInteger(tc.rawOutput.exitCode)
        ? tc.rawOutput.exitCode
        : null
      : status === 'completed'
        ? 0
        : status === 'failed'
          ? 1
          : null,
    durationMs: null,
    pluginId: null,
    scriptPath: null,
  });
  // A Chrome MCP call keeps its protocol identity and image output even when an ACP server calls it a read or execute.
  switch (browser ? 'browser' : tc.kind) {
    case 'execute': {
      // an agent's own description of the command (Claude's Bash input carries one), for the activity line
      const d = tc.rawInput?.description;
      return typeof d === 'string' && d.trim() ? { ...cmd([], commandOf(tc)), description: d.trim() } : cmd([], commandOf(tc));
    }
    case 'read':
      return cmd(
        [
          {
            type: 'read',
            command: tc.title ?? 'Read',
            name: String(path ?? tc.title ?? '')
              .split('/')
              .pop(),
            path: path ?? '',
          },
        ],
        String(tc.title ?? `Read ${path ?? ''}`),
      );
    case 'search':
      return cmd(
        [
          {
            type: 'search',
            command: tc.title ?? 'Search',
            query: tc.rawInput?.pattern ?? tc.rawInput?.query ?? tc.title ?? null,
            path,
          },
        ],
        String(tc.title ?? 'Search'),
      );
    case 'fetch': {
      const url = tc.rawInput?.url;
      return {
        type: 'webSearch',
        id,
        query: url ? '' : String(tc.rawInput?.query ?? tc.title ?? ''),
        action: url
          ? {
              type: 'openPage',
              url,
            }
          : {
              type: 'search',
              query: String(tc.rawInput?.query ?? tc.title ?? ''),
            },
        results: null,
      };
    }
    default: {
      const text = toolOutput(tc.content);
      const images = contentBlocks(tc.content)
        .filter((c) => c.type === 'content')
        .map((c) => normalizeContentBlock(c.content))
        .filter((block) => block?.type === 'image');
      return {
        type: 'mcpToolCall',
        id,
        server: mcp?.[1] ?? '',
        tool: mcp?.[2] ?? title,
        status,
        arguments: tc.rawInput ?? {},
        appContext: null,
        mcpAppUi: null,
        pluginId: null,
        readOnlyHint: null,
        result:
          status === 'completed'
            ? {
                content: [
                  ...(text
                    ? [
                        {
                          type: 'text',
                          text,
                        },
                      ]
                    : []),
                  ...images,
                ],
                structuredContent: null,
                _meta: null,
              }
            : null,
        error: status === 'failed' ? { message: text || 'Failed' } : null,
        durationMs: null,
      };
    }
  }
}
