// The portable sage-mcp: MCP (newline-delimited JSON-RPC) on stdio to the harness, forwarded line for line to the Host's tool socket. The Swift sage-mcp (native/sage-mcp) does the same on macOS.
// Both streams' lines are cut by the Rust core (electron/platform/coreFraming.cjs), as every tool stream's are: it runs where
// a core is beside it (a Host's version, a Linux checkout), and a Linux package ships the Rust bridge (core/crates/sage-mcp).
import { createRequire } from 'node:module';
import net from 'node:net';

const require = createRequire(import.meta.url);
const { MOST_UNITS, openFramer } = require('../../electron/platform/coreFraming.cjs');

const VERSION = '1.0.0';
/** The tool socket on Windows is `127.0.0.1:<port>` (electron/capabilities/mcp/socket.cjs); any other address is a unix socket's path. */
const LOOPBACK = /^127\.0\.0\.1:(\d+)$/;

/**
 * Each complete line of `stream`'s bytes to `onLine`, without its newline or a CR before it; `tooLong` when one passes
 * the framer's limit. A line the stream ends without a newline is no line, as on any MCP stream.
 * @param {NodeJS.ReadableStream} stream @param {ReturnType<typeof openFramer>} framer @param {(line: string) => void} onLine @param {() => void} tooLong
 */
function linesOf(stream, framer, onLine, tooLong) {
  stream.on('data', (/** @type {Buffer} */ chunk) => {
    const framed = framer.push(chunk);
    for (const line of framed.lines) onLine(String(line).replace(/\r$/, ''));
    if (framed.tooLong) tooLong();
  });
}

/**
 * Run until the harness closes stdin or the Host closes the socket; resolves with the exit code.
 * @param {{ env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream, stdout: { write: (s: string) => unknown }, stderr: { write: (s: string) => unknown }, pid?: number, ppid?: number, connect?: typeof net.connect, lineUnits?: number, addon?: Parameters<typeof openFramer>[1] }} o
 *   `lineUnits`: the longest line either side may send, in UTF-16 units (by default as long as a string can be);
 *   `addon`: the core that frames them (by default the one beside this code)
 * @returns {Promise<number>}
 */
export function runShim({
  env,
  stdin,
  stdout,
  stderr,
  pid = process.pid,
  ppid = process.ppid,
  connect = net.connect,
  lineUnits = MOST_UNITS,
  addon,
}) {
  const fail = (/** @type {string} */ message) => (stderr.write(`sage-mcp: ${message}\n`), 1);
  const socketPath = env.SAGE_MCP_SOCKET;
  const token = env.SAGE_MCP_TOKEN;
  if (!socketPath) return Promise.resolve(fail('SAGE_MCP_SOCKET is not set'));
  if (!token) return Promise.resolve(fail('SAGE_MCP_TOKEN is not set'));
  /** @type {ReturnType<typeof openFramer>[]} the harness's stream's, then the socket's */
  const framers = [];
  try {
    // one at a time: the first is held before the second can fail
    for (let i = 0; i < 2; i++) framers.push(openFramer(lineUnits, addon));
  } catch (e) {
    // no core, no reader: said before anything connects, as a missing socket is
    for (const framer of framers) framer.close();
    return Promise.resolve(fail(/** @type {Error} */ (e).message));
  }
  const json = (/** @type {object} */ obj) => `${JSON.stringify(obj)}\n`;

  return new Promise((resolve) => {
    const port = LOOPBACK.exec(socketPath)?.[1];
    const socket = port ? connect({ host: '127.0.0.1', port: Number(port) }) : connect(socketPath);
    let serverName = 'sage';
    let greeted = false;
    let done = false;
    /** whether the harness closed stdin before the Host answered hello */
    let stdinClosed = false;
    /** @type {string[]} lines the harness sent before the Host answered hello */
    const queued = [];
    const finish = (/** @type {number} */ code) => {
      if (done) return;
      done = true;
      socket.destroy();
      for (const framer of framers) framer.close();
      // a refused or lost connection ends the process; an open stdin would keep it alive until the harness closed it
      stdin.pause();
      stdin.removeAllListeners('data');
      resolve(code);
    };
    // the first end says why; the close that follows a socket's error, or a refusal, says nothing more
    const failed = (/** @type {string} */ message) => void (done || finish(fail(message)));
    const tooLong = () => failed('a message is longer than a line can be');
    socket.on('error', (e) => failed(`can't reach the Host: ${e.message}`));
    socket.on('connect', () =>
      socket.write(json({ jsonrpc: '2.0', id: 'hello', method: 'hello', params: { token, pid, ppid, version: VERSION } })),
    );
    // the Host went away (or revoked this session): nothing more can be served
    socket.on('close', () => (greeted ? finish(0) : failed('the Host refused the connection')));

    const fromHost = (/** @type {string} */ line) => {
      if (!line || done) return;
      if (greeted) return void stdout.write(`${line}\n`);
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return failed('the Host refused the connection');
      }
      if (reply.error) return failed(`the Host refused the connection: ${reply.error.message ?? ''}`);
      serverName = reply.result?.serverName ?? serverName;
      greeted = true;
      queued.splice(0).forEach(handle);
      // the harness closed stdin while hello was on its way: what it sent has now been served, as the Rust bridge does
      if (stdinClosed) finish(0);
    };
    linesOf(socket, framers[1], fromHost, tooLong);

    // the harness closing stdin ends this process, as it does the Swift one, once what it sent before hello is served
    const harnessGone = () => (greeted ? finish(0) : void (stdinClosed = true));
    stdin.on('end', harnessGone);
    stdin.on('close', harnessGone);
    linesOf(stdin, framers[0], (line) => (greeted ? handle(line) : queued.push(line)), tooLong);
    const handle = (/** @type {string} */ line) => {
      if (!line || done) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return void stdout.write(json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
      // the harness cancelling a call goes to the Host, which stops that call; it needs no answer
      if (msg.method === 'notifications/cancelled' && msg.id === undefined) return void socket.write(`${line}\n`);
      // other notifications and responses need no answer
      if (typeof msg.method !== 'string' || msg.id === undefined || msg.id === null) return;
      const reply = (/** @type {object} */ body) => stdout.write(json({ jsonrpc: '2.0', id: msg.id, ...body }));
      if (msg.method === 'initialize')
        reply({
          result: {
            protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: serverName, version: VERSION },
          },
        });
      else if (msg.method === 'ping') reply({ result: {} });
      else if (msg.method === 'tools/list' || msg.method === 'tools/call') {
        if (socket.writable) socket.write(`${line}\n`);
        else reply({ error: { code: -32603, message: 'The Host is not reachable' } });
      } else reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
    };
  });
}
