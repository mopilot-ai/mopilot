// The relay under test for the load harness: the real service started in this process on an in-process Postgres, or as a
// child process (`node relay/src/bin.mjs`) on a real Postgres, so the harness can kill and restart it.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../../relay/src/main.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../relay/src/bin.mjs');

export async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  await new Promise((r) => server.close(r));
  return port;
}

/**
 * The service in this process. `kill()` closes its sockets and listener at once (its database keeps everything), `start()` brings it back on the same port.
 * @param {{ env: Record<string, string>, pool: any, port?: number }} o
 */
export async function inProcessRelay({ env, pool, port }) {
  const fixed = port ?? (await freePort());
  /** @type {Awaited<ReturnType<typeof start>> | null} */
  let running = null;
  const host = {
    pid: process.pid,
    url: `ws://127.0.0.1:${fixed}/v1/ws`,
    http: `http://127.0.0.1:${fixed}`,
    async start() {
      running = await start({ ...env, PORT: String(fixed), HOST: '127.0.0.1' }, { pool, log: () => undefined });
    },
    async kill() {
      await running?.relay.close();
      running = null;
    },
    async stop() {
      await host.kill();
    },
  };
  return host;
}

/**
 * The service as a child process. `kill()` is SIGKILL: no handler runs, as when a VM loses power.
 * @param {{ env: Record<string, string>, port?: number, bin?: string, startTimeoutMs?: number, killTimeoutMs?: number }} o `bin` is the script to run (the relay's bin.mjs);
 * a relay that has not said it is listening after `startTimeoutMs`, or has not exited `killTimeoutMs` after a signal, is killed outright
 */
export async function childRelay({ env, port, bin = BIN, startTimeoutMs = 30_000, killTimeoutMs = 10_000 }) {
  const fixed = port ?? (await freePort());
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  const host = {
    get pid() {
      return child?.pid ?? null;
    },
    url: `ws://127.0.0.1:${fixed}/v1/ws`,
    http: `http://127.0.0.1:${fixed}`,
    logLines: 0,
    /** how many times the relay process ended on its own (the harness's own kills and stops are not counted) */
    crashes: 0,
    /** how many sockets the relay closed, by close code (read from its own log) */
    closeCodes: /** @type {Record<string, number>} */ ({}),
    /** how many log events of each kind the relay printed (slow_consumer, db_error, error, ...), except the per-connection ones */
    events: /** @type {Record<string, number>} */ ({}),
    /** the messages of the first few `error` events, to say what they were */
    errorSamples: /** @type {string[]} */ ([]),
    stderr: /** @type {string[]} */ ([]),
    async start() {
      child = spawn(process.execPath, [bin], {
        env: { ...process.env, ...env, PORT: String(fixed), HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr?.on('data', (d) => host.stderr.push(String(d)));
      const starting = child;
      starting.once('exit', () => {
        if (child === starting) host.crashes++;
      });
      await new Promise((resolve, reject) => {
        const giveUp = setTimeout(() => {
          starting.kill('SIGKILL');
          reject(new Error(`relay not listening after ${startTimeoutMs} ms`));
        }, startTimeoutMs);
        starting.once('exit', () => clearTimeout(giveUp));
        let buffer = '';
        child?.stdout?.on('data', (d) => {
          buffer += String(d);
          const lines = buffer.split('\n');
          buffer = /** @type {string} */ (lines.pop());
          host.logLines += lines.length;
          for (const l of lines) {
            const code = /^\{"event":"close".*"code":(\d+)/.exec(l)?.[1];
            if (code) host.closeCodes[code] = (host.closeCodes[code] ?? 0) + 1;
            const event = /^\{"event":"([a-z_]+)"/.exec(l)?.[1];
            if (event && event !== 'close' && event !== 'connect') host.events[event] = (host.events[event] ?? 0) + 1;
            const message = event === 'error' ? /"message":"([^"]*)"/.exec(l)?.[1] : undefined;
            if (message && host.errorSamples.length < 5) host.errorSamples.push(message);
          }
          if (lines.some((l) => l.includes('"listening"'))) {
            clearTimeout(giveUp);
            resolve(undefined);
          }
        });
        child?.once('exit', (code) => reject(new Error(`relay exited with ${code}: ${host.stderr.join('').slice(-300)}`)));
      });
    },
    /** @param {NodeJS.Signals} [signal] */
    async kill(signal = 'SIGKILL') {
      const gone = child;
      child = null;
      if (!gone || gone.exitCode !== null) return;
      const exited = once(gone, 'exit');
      gone.kill(signal);
      // a relay that ignores the signal must not hang the harness
      const escalate = setTimeout(() => gone.kill('SIGKILL'), killTimeoutMs);
      await exited;
      clearTimeout(escalate);
    },
    async stop() {
      await host.kill('SIGTERM');
    },
  };
  return host;
}
