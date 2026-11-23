// Who is at the far end of an accepted loopback TCP connection on Windows, by the kernel's word: netstat's TCP table names the process that owns each end. Windows has no lsof, and Node gives no named pipe's client pid, so sage-mcp reaches main over 127.0.0.1 there (socket.cjs) and the http channel already does (../httpMcp.cjs).
const path = require('node:path');
const { proc } = require('../../platform/ports/proc.cjs');
const { getEnv } = require('../../platform/winbin.cjs');

/** netstat in System32, by its full path, so no PATH entry can stand in for it. */
const netstatPath = (env = process.env) => path.win32.join(getEnv(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'netstat.exe');

/**
 * `netstat -ano -p TCP` rows as `local foreign -> pid`. A row is `TCP <local> <foreign> <state> <pid>`; the state is
 * in the system's language, so only the addresses and the pid are read.
 * @param {string} out @returns {Map<string, number>}
 */
function parseNetstat(out) {
  const owners = new Map();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols.at(-1));
    if (cols[0] === 'TCP' && cols.length >= 5 && Number.isInteger(pid)) owners.set(`${cols[1]} ${cols[2]}`, pid);
  }
  return owners;
}

/**
 * The pid of the process holding the other end of `socket`, a connection main accepted on 127.0.0.1: the row whose local
 * address is the connection's remote one. Null when netstat lists no such row (the process is gone, or netstat failed).
 * @param {{ remotePort?: number, localPort?: number }} socket
 * @param {typeof proc.execFile} [exec] @param {Record<string, string | undefined>} [env]
 * @returns {Promise<number | null>}
 */
async function tcpOwnerWindows(socket, exec = proc.execFile, env = process.env) {
  const { remotePort, localPort } = socket;
  if (!remotePort || !localPort) return null;
  const row = `127.0.0.1:${remotePort} 127.0.0.1:${localPort}`;
  const find = () =>
    new Promise((resolve) => {
      // windowsHide: no console window flashes up for it; a machine with many connections prints megabytes
      const o = { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
      exec(netstatPath(env), ['-ano', '-p', 'TCP'], o, (_err, stdout) => resolve(parseNetstat(String(stdout || '')).get(row) ?? null));
    });
  // netstat can run past its time limit on a loaded machine and print nothing or part of the table: that says nothing
  // about the peer, so ask once more
  return /** @type {number | null} */ ((await find()) ?? (await find()));
}

/**
 * Whether process `pid` holds the far end of `socket` (socket.cjs peerHolds on Windows): null when it does, or why not.
 * @param {{ socket: any, pid: number, execFile?: typeof proc.execFile, env?: Record<string, string | undefined> }} o
 */
async function peerHoldsWindows({ socket, pid, execFile, env }) {
  const owner = await tcpOwnerWindows(socket, execFile, env);
  if (owner === null) return 'socket not found';
  return owner === pid ? null : `process ${pid} is not the one connected`;
}

module.exports = { netstatPath, parseNetstat, tcpOwnerWindows, peerHoldsWindows };
