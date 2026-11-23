// A fake CLI's stdout over the production utility host, including asynchronous parent-port acknowledgements.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { host } = require('../../electron/capabilities/browser/playwrightHost.cjs');

export function extensionWire(child: any) {
  const port: any = new EventEmitter();
  port.postMessage = (message: any) => child.emit('message', message);
  const { stdout } = host({ port, proc: {}, load: () => {}, resolve: () => '/synthetic/package.json' });
  const emit = child.emit.bind(child);
  child.emit = (event: string, ...args: any[]) => {
    const message = args[0];
    if (event === 'message' && message?.type === 'out' && typeof message.data === 'string') return stdout.write(message.data);
    return emit(event, ...args);
  };
  const post = child.postMessage.bind(child);
  child.postMessage = (message: any) => {
    const result = post(message);
    if (message.type === 'out-ack') queueMicrotask(() => port.emit('message', { data: message }));
    return result;
  };
  return (text: string) => stdout.write(text);
}

/** A Your Chrome utility process that answers every tools/call when the test lets it, recording what it was sent. */
export function slowChrome() {
  const sent: string[] = [];
  const replies: Array<() => void> = [];
  const fork = () => {
    const child: any = new EventEmitter();
    child.stderr = new EventEmitter();
    let output: (text: string) => unknown;
    const reply = (msg: any) => output(JSON.stringify(msg) + '\n');
    child.postMessage = (m: any) => {
      if (m.type === 'stop') return setImmediate(() => child.emit('exit', 0));
      if (m.type !== 'in') return;
      const msg = JSON.parse(m.data);
      if (msg.method === 'initialize') setImmediate(() => reply({ jsonrpc: '2.0', id: msg.id, result: {} }));
      if (msg.method !== 'tools/call') return;
      sent.push(msg.params.name);
      replies.push(() =>
        reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '### Page\n- Page URL: https://a.test/' }] } }),
      );
    };
    output = extensionWire(child);
    child.kill = () => child.emit('exit', null);
    return child;
  };
  return { fork, sent, replies };
}

/** A fork() whose children answer MCP like @playwright/mcp, through `onCall`; `silent` calls never answer. */
export function scriptedChrome(
  onCall: (name: string, args: any) => any = () => ({ content: [{ type: 'text', text: '### Page\n- Page URL: https://shop.test/' }] }),
) {
  const children: any[] = [];
  const o = { silent: false, gate: null as Promise<unknown> | null, startGate: null as Promise<unknown> | null };
  const fork = (_m: string, _a: string[], options: any) => {
    const child: any = new EventEmitter();
    Object.assign(child, { options, got: [] as any[], stopped: false });
    let output: (text: string) => unknown;
    const reply = (msg: any) => setImmediate(() => output(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`));
    child.postMessage = (m: any) => {
      if (m.type === 'stop') {
        child.stopped = true;
        return void setImmediate(() => child.emit('exit', 0));
      }
      if (m.type !== 'in') return;
      const msg = JSON.parse(m.data);
      child.got.push(msg);
      if (msg.method === 'initialize') return void Promise.resolve(o.startGate).then(() => reply({ id: msg.id, result: {} }));
      if (msg.method !== 'tools/call' || o.silent) return;
      void Promise.resolve(o.gate).then(() => reply({ id: msg.id, result: onCall(msg.params.name, msg.params.arguments) }));
    };
    output = extensionWire(child);
    child.kill = () => child.emit('exit', null);
    children.push(child);
    return child;
  };
  return { fork, children, o };
}
