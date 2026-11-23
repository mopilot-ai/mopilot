// A computer-use helper on a unix socket, scripted per request, whose connections can be dropped: the
// helper process exiting or crashing, as the helper client (electron/capabilities/computer.cjs) sees it.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type Reply = { result?: any; error?: any; drop?: boolean; hold?: boolean };

/** A helper on a socket: `answer` decides each reply; `drop` closes the connection instead (the helper exited). */
export async function scriptedHelper(
  answer: (method: string, params: any, n: number) => Reply | Promise<Reply>,
  hello: (n: number, params: any) => Reply = () => ({ result: { pid: 1, version: 'test' } }),
  at?: string,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuh-'));
  // `at`: listen where a launch config says (the launched helper), else in a directory of its own
  const socket = at ?? path.join(dir, 'h.sock');
  const log: { method: string; params: any; conn: number }[] = [];
  const conns = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer((s) => {
    const conn = ++connections;
    conns.add(s);
    s.on('close', () => conns.delete(s));
    s.on('error', () => {});
    s.setEncoding('utf8');
    let buf = '';
    s.on('data', async (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        log.push({ method: msg.method, params: msg.params, conn });
        const n = log.filter((l) => l.method === msg.method).length;
        const r = msg.method === 'hello' ? hello(n, msg.params) : await answer(msg.method, msg.params, n);
        if (r.drop) {
          s.destroy();
          return;
        }
        if (r.hold) continue;
        s.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(r.error ? { error: r.error } : { result: r.result ?? { ok: true } }) })}\n`,
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  return {
    socket,
    log,
    connections: () => connections,
    /** the helper process went away: every connection drops */
    kill: () => {
      for (const s of conns) s.destroy();
    },
    /** nothing listens any more: a relaunch fails */
    close: () =>
      new Promise<void>((r) => {
        for (const s of conns) s.destroy();
        server.close(() => r());
      }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
