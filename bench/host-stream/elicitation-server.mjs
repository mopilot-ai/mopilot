// Run-owned stdio MCP probe: asks a form and an inert URL, then returns the actual client answers without signing anyone in.
import readline from 'node:readline';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LINK = 'https://example.com/mopilot-host-elicitation-probe';

/** @param {(message: any) => void} send */
export function createProbe(send) {
  const waiting = new Map();
  let next = 0;
  const ask = (params) =>
    new Promise((resolve) => {
      const id = `probe-${++next}`;
      waiting.set(id, resolve);
      send({ jsonrpc: '2.0', id, method: 'elicitation/create', params });
    });
  return async (message) => {
    if (!message.method) {
      const finish = waiting.get(message.id);
      waiting.delete(message.id);
      finish?.(message.error ? { error: message.error } : message.result);
      return;
    }
    if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize')
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'host-stream-probe', version: '1.0.0' },
      };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'probe',
            description: 'Ask a test form and an inert example.com URL; returns both answers. No real login or external request.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    else if (message.method === 'tools/call' && message.params?.name === 'probe') {
      const form = await ask({
        mode: 'form',
        message: 'Host probe: enter the verification word.',
        requestedSchema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
      });
      const link = await ask({
        mode: 'url',
        message: 'Host probe: inert URL, no login required.',
        url: LINK,
        elicitationId: `link-${next}`,
      });
      result = { content: [{ type: 'text', text: JSON.stringify({ form, link }) }] };
    } else {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown probe method or tool.' } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result });
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receive = createProbe((message) => {
    if (process.argv[2] && message.result?.content) fs.writeFileSync(process.argv[2], message.result.content[0].text, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    try {
      void receive(JSON.parse(line)).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  });
}
