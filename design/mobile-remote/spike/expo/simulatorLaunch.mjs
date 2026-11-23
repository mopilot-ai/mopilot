// Bound a simulator launch subprocess and report its actual exit or timeout without touching other processes.
/** @param {() => import('node:child_process').ChildProcess} start @param {number} timeoutMs */
export function launchWithDeadline(start, timeoutMs) {
  return new Promise((resolve) => {
    const child = start();
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ status: 'timeout' });
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolve({ status: 'error', error: String(error) }); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ status: code === 0 ? 'returned' : 'failed', code, signal }); });
  });
}
