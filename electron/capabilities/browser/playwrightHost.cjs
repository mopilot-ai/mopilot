// Runs @playwright/mcp's CLI inside an Electron utilityProcess (the RunAsNode fuse is off, so it can't
// run as a plain Node child). A utility process has no stdin, so the CLI's stdio transport reads from
// and writes to streams that ride the parent port: main sends {type: 'start', args} once, then MCP
// lines as {type: 'in', data}. The CLI's output goes to main as it is written, {type: 'output', seq, data}, for the core to
// frame there (./extensionProcess.cjs); each write waits for main's acknowledgement before the next.
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');

/**
 * The MCP SDK's stdio transport the CLI starts (`new StdioServerTransport()`, which reads `process.stdin` and writes
 * `process.stdout`), from the playwright-core bundle @playwright/mcp loads.
 * @param {(id: string, o?: { paths: string[] }) => string} resolve @param {(id: string) => any} load
 */
function sdkTransport(resolve, load) {
  const mcp = path.dirname(resolve('@playwright/mcp/package.json'));
  return load(resolve('playwright-core/lib/utilsBundle', { paths: [mcp] })).StdioServerTransport;
}

/**
 * Puts the CLI's stdio on `stdin` and `stdout`. Where `proc.stdin` and `proc.stdout` can be replaced (macOS, Linux) they
 * are, as before. A Windows utility process defines them so that they can't be ("Cannot redefine property: stdin"), which
 * stopped Your Chrome there before the CLI started; there the stdio transport, the CLI's one reader and writer, is
 * pointed at these streams instead, and closed when `stdin` ends, as the CLI closes it when its stdin ends; the CLI's
 * exit watchdog hears `stdin`'s close on the process's own stdin.
 * (@playwright/mcp's createConnection would take any streams, but it builds the browser without the CLI's options, so
 * `--profile-dir-name`, the Chrome profile Your Chrome connects to, would be lost, and it has no exit watchdog.)
 * @param {any} proc @param {import('node:stream').Readable} stdin @param {import('node:stream').Writable} stdout
 * @param {() => { prototype: { _stdin?: unknown, _stdout?: unknown, start(): Promise<void>, close(): Promise<void> } }} transport
 * @returns {'process' | 'transport'} which was rewired
 */
function wireStdio(proc, stdin, stdout, transport) {
  const replaceable = ['stdin', 'stdout'].every((k) => Object.getOwnPropertyDescriptor(proc, k)?.configurable !== false);
  if (replaceable) {
    Object.defineProperty(proc, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(proc, 'stdout', { value: stdout, configurable: true });
    return 'process';
  }
  const proto = transport().prototype;
  const start = proto.start;
  proto.start = function startOnHostStdio() {
    this._stdin = stdin;
    this._stdout = stdout;
    stdin.once('end', () => void this.close());
    return start.call(this);
  };
  // The CLI's exit watchdog listens for `close` on process.stdin, which here stays the process's own: the host stdin's
  // close is passed on to it, so a stop ends the CLI gracefully (its tab group closed) instead of by main's kill after STOP_MS.
  // The synthetic `close` also runs that stream's other `close` listeners; that is fine, since the process exits right after.
  stdin.once('close', () => proc.stdin?.emit?.('close'));
  return 'transport';
}

/**
 * Wires the parent port to the CLI's stdio and starts the CLI on the first 'start' message.
 * @param {{ port: { on(e: 'message', fn: (e: { data: any }) => void): void, postMessage(m: any): void },
 *           proc?: any, load?: (id: string) => any, resolve?: (id: string, o?: { paths: string[] }) => string,
 *           transport?: () => any }} o
 */
function host({ port, proc = process, load = require, resolve = require.resolve, transport = () => sdkTransport(resolve, load) }) {
  const stdin = new PassThrough();
  let sequence = 0;
  /** @type {{ seq: number, done: Function } | null} the write main has not acknowledged */
  let writing = null;
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      writing = { seq: ++sequence, done: cb };
      port.postMessage({ type: 'output', seq: writing.seq, data: chunk });
    },
  });

  let started = false;
  port.on('message', (e) => {
    const m = e.data || {};
    if (m.type === 'out-ack' && writing !== null && m.seq === writing.seq) {
      const { done } = writing;
      writing = null;
      done();
    } else if (m.type === 'in' && typeof m.data === 'string') stdin.write(m.data);
    else if (m.type === 'stop') stdin.end();
    else if (m.type === 'start' && !started) {
      started = true;
      wireStdio(proc, stdin, stdout, transport);
      // the package exports only its API, so the CLI is found next to package.json
      const cli = path.join(path.dirname(resolve('@playwright/mcp/package.json')), 'cli.js');
      proc.argv = [proc.execPath, cli, ...(Array.isArray(m.args) ? m.args.map(String) : [])];
      load(cli);
    }
  });
  return { stdin, stdout };
}

// in the utility process; required anywhere else (a test), it only defines host()
if (process.parentPort) host({ port: process.parentPort });

module.exports = { host, wireStdio, sdkTransport };
