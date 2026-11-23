// Tiny stdio MCP server with one tool, sage_screenshot, which returns a PNG of the word in argv[2].
// argv[3]: a log file ("CALLED" is appended per call). argv[4] "ro": annotate the tool readOnlyHint.
import fs from 'node:fs';
import { wordPng } from './png.mjs';

const [, , WORD = 'NOWORD', LOG, MODE] = process.argv;
const log = (s) => LOG && fs.appendFileSync(LOG, s + '\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function handle(m) {
  if (m.method === 'initialize')
    return send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        protocolVersion: m.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sage-test', version: '0.0.1' },
      },
    });
  if (m.method === 'tools/list')
    return send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        tools: [
          {
            name: 'sage_screenshot',
            description: 'Take a screenshot of the Sage test screen. Returns a PNG image.',
            inputSchema: { type: 'object', properties: {} },
            ...(MODE === 'ro' ? { annotations: { readOnlyHint: true } } : {}),
          },
        ],
      },
    });
  if (m.method === 'tools/call') {
    log('CALLED');
    return send({
      jsonrpc: '2.0',
      id: m.id,
      result: { content: [{ type: 'image', data: wordPng(WORD).toString('base64'), mimeType: 'image/png' }] },
    });
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not found' } });
}
