// In-process SDK MCP tool returning an image (Sage's computer-use channel): the model must read a random word.
import { sdk, open, brief, toolUses } from '../lib/claude.mjs';
import { wordPng, randomWord, sawWord } from '../lib/png.mjs';

export const id = 'C9';
export const title = 'In-process SDK MCP image tool (computer-use channel)';
export const timeoutMs = 400000;

export default async function run(ctx) {
  const word = randomWord();
  const png = wordPng(word).toString('base64');
  const out = { word };
  for (const label of ['default', 'readOnly']) {
    const handlerCalls = [];
    const permCalls = [];
    const server = sdk.createSdkMcpServer({
      name: 'sage',
      version: '0.0.1',
      tools: [
        sdk.tool('sage_screenshot', 'Take a screenshot of the user screen. Returns a PNG image.', {}, async (_args, extra) => {
          handlerCalls.push({ sessionId: extra?.sessionId ?? null, metaKeys: Object.keys(extra?._meta ?? {}) });
          return { content: [{ type: 'image', data: png, mimeType: 'image/png' }] };
        }),
      ],
    });
    const perms =
      label === 'default'
        ? {
            permissionMode: 'default',
            canUseTool: async (name, input) => (permCalls.push(name), { behavior: 'allow', updatedInput: input }),
          }
        : {
            permissionMode: 'dontAsk',
            allowedTools: ['Read', 'Grep', 'Glob', 'mcp__sage__sage_screenshot'],
            canUseTool: async (name) => (permCalls.push(name), { behavior: 'deny', message: 'no' }),
          };
    const s = open(ctx, label, { mcpServers: { sage: server }, ...perms });
    const res = await s.turn(
      'Call the mcp__sage__sage_screenshot tool once, then tell me the single word written in the image, in uppercase, and nothing else.',
      {},
      180000,
    );
    const init = s.msgs.find((m) => m.subtype === 'init');
    out[label] = {
      result: brief(res),
      correct: sawWord(res?.result, word),
      initHasServer: (init?.mcp_servers ?? []).some((m) => m.name === 'sage'),
      initHasTool: (init?.tools ?? []).includes('mcp__sage__sage_screenshot'),
      toolUses: toolUses(s.msgs),
      handlerCalls,
      permCalls,
    };
    await s.close();
  }
  const { default: d, readOnly: ro } = out;
  return ctx.result(out, {
    'init lists the sage server and tool': d.initHasServer && d.initHasTool,
    'the model reads the image (default mode)': d.correct,
    'the model reads the image (dontAsk + allowedTools)': ro.correct,
    'the tool is deferred behind ToolSearch': d.toolUses.includes('ToolSearch'),
    'canUseTool is asked in default mode': d.permCalls.includes('mcp__sage__sage_screenshot'),
    'canUseTool is not asked with allowedTools': !ro.permCalls.includes('mcp__sage__sage_screenshot'),
    'handler extra has no sessionId': d.handlerCalls.every((c) => c.sessionId === null),
  });
}
