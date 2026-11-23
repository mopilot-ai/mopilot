// A small stdio MCP server for MoMo's MCP proxy tests and the E2E run (#2999 C0): notes_list (says it only reads), notes_add (a change) and env_keys (the names of the env it was started with, to check what MoMo passes it).
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const notes = [];
const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'notes_list',
      description: 'List the notes.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    { name: 'notes_add', description: 'Add a note.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    {
      name: 'env_keys',
      description: 'The env names.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'notes_add') notes.push(String(req.params.arguments?.text ?? ''));
  if (req.params.name === 'env_keys')
    return {
      content: [{ type: 'text', text: JSON.stringify({ keys: Object.keys(process.env).sort(), TOKEN: process.env.TOKEN ?? null }) }],
    };
  return { content: [{ type: 'text', text: JSON.stringify(notes) }] };
});
server.connect(new StdioServerTransport());
