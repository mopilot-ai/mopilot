// A persistent line-protocol connection to a served Host, so a test sees the standing of one connection (pairing, auth) and not only one-shot calls.
import net from 'node:net';

/** One persistent connection to a served Host, so the connection's standing is what the test sees. */
export function line(socketPath: string, token?: string) {
  const socket = net.connect(socketPath);
  const waiting: ((r: any) => void)[] = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (c) => {
    buffer += c;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      waiting.shift()?.(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  // the Host ending this connection (a client it no longer trusts)
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.on('error', () => undefined);
  let id = 0;
  const call = (method: string, params?: any, withToken = token) =>
    new Promise<any>((resolve) => {
      waiting.push(resolve);
      socket.write(`${JSON.stringify({ id: ++id, method, params, ...(withToken ? { token: withToken } : {}) })}\n`);
    });
  // the app's `request`: the result, or a rejection carrying the Host's code
  const request = async (method: string, params?: any) => {
    const r = await call(method, params);
    if (r.error) throw Object.assign(new Error(r.error), { code: r.code });
    return r.result;
  };
  return { call, request, closed, close: () => socket.destroy() };
}
