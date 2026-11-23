// Owned Chrome shutdown waits for the process-exit receipt before a caller may delete its scratch profile.
export function trackProcessExit(child) {
  return new Promise((resolve) => {
    const finished = () => {
      child.removeListener('exit', finished);
      child.removeListener('error', failed);
      resolve(undefined);
    };
    const failed = () => {
      if (!child.pid) finished();
    };
    child.once('exit', finished);
    child.on('error', failed);
    if (child.exitCode != null || child.signalCode != null) finished();
  });
}

export async function waitForProcessExit(child, stopped, ms) {
  const wait = () =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      stopped.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  if (await wait()) return;
  child.kill();
  if (await wait()) return;
  child.kill('SIGKILL');
  if (!(await wait())) throw new Error('The owned Chrome process did not exit; its profile is still in use.');
}
