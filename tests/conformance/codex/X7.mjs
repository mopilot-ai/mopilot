// Tool injection for computer use: dynamicTools (item/tool/call round trip, code-mode image quirk)
// and a per-thread MCP server (approval under approvalPolicy never, readOnlyHint).
import fs from 'node:fs';
import path from 'node:path';
import { open, agentText } from '../lib/codex.mjs';
import { wordPng, randomWord, sawWord } from '../lib/png.mjs';

export const id = 'X7';
export const title = 'Tool injection channel for computer use';
export const timeoutMs = 600000;

const MCP = path.join(path.dirname(new URL(import.meta.url).pathname), '../lib/mcp-server.mjs');
const PROMPT =
  'Call the sage_screenshot tool exactly once. It returns an image showing a short word in capital letters. Reply with only that word. If you cannot see an image, reply NOIMAGE.';
// In code mode a dynamic tool resolves to a bare data-URL string; the hint makes the model pass it to image().
const HINTED =
  'Take a screenshot of the Sage test screen. In exec scripts this tool resolves to an image data-URL string; pass the returned value straight to image() to view it.';
const spec = (description) => ({
  type: 'function',
  name: 'sage_screenshot',
  description,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
});

export default async function run(ctx) {
  const words = {};
  const calls = [];
  const c = await open(ctx, 'session', {
    onRequest: (m) => {
      if (m.method !== 'item/tool/call') return undefined;
      calls.push({ keys: Object.keys(m.params).sort(), tool: m.params.tool, namespace: m.params.namespace ?? null });
      return {
        contentItems: [
          { type: 'inputImage', imageUrl: 'data:image/png;base64,' + wordPng(words[m.params.threadId] ?? 'NOWORD').toString('base64') },
        ],
        success: true,
      };
    },
  });
  const o = {};
  const read = async (tid, w) => {
    const r = await c.turn(tid, PROMPT, {}, 150000);
    const items = c.items(r.from, tid);
    const final = agentText(items);
    return {
      status: r.status,
      expected: w,
      final: final.slice(0, 200),
      correct: sawWord(final, w),
      tools: items
        .filter((i) => /Tool/.test(i.type))
        .map((i) => ({ type: i.type, status: i.status, error: i.error ? String(JSON.stringify(i.error)).slice(0, 200) : undefined })),
    };
  };

  {
    const t = await c.startThread({ dynamicTools: [spec(HINTED)] });
    const tid = t.result.thread.id;
    o.dynamic = await read(tid, (words[tid] = randomWord()));
    o.dynamic.call = calls[0] ?? null;
  }
  {
    const t = await c.startThread({
      dynamicTools: [
        { type: 'namespace', name: 'sage_computer', description: 'Sage computer-use tools', tools: [spec('Take a screenshot.')] },
      ],
    });
    o.namespaceAccepted = !t.error;
  }
  for (const [label, mode] of [
    ['mcpNoApproval', ''],
    ['mcpReadOnlyHint', 'ro'],
  ]) {
    const w = randomWord();
    const log = path.join(ctx.cwd('mcplog'), 'calls.log');
    const t = await c.startThread({ config: { mcp_servers: { sage: { command: process.execPath, args: [MCP, w, log, mode] } } } });
    if (t.error) {
      o[label] = { startError: t.error.message };
      continue;
    }
    o[label] = {
      ...(await read(t.result.thread.id, w)),
      serverCalled: fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('CALLED'),
    };
  }
  const call = o.dynamic.call;
  return ctx.result(o, {
    'dynamic tool call arrives as item/tool/call with threadId, turnId, callId, tool':
      !!call && ['threadId', 'turnId', 'callId', 'tool'].every((k) => call.keys.includes(k)),
    'the item is a dynamicToolCall': o.dynamic.tools.some((t) => t.type === 'dynamicToolCall'),
    'namespace dynamic tools are accepted': o.namespaceAccepted,
    'per-thread MCP without approval fails under approvalPolicy never':
      !o.mcpNoApproval.serverCalled && JSON.stringify(o.mcpNoApproval.tools).includes('approval'),
    'per-thread MCP with readOnlyHint is called and its image reaches the model':
      o.mcpReadOnlyHint.serverCalled && o.mcpReadOnlyHint.correct,
  });
}
