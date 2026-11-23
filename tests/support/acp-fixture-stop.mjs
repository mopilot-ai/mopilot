// Await fixture-owned ACP startup work and exact child exits before removing files, including retired sessions and probes.
export function acpFixtureProcesses(spawnFn) {
  const children = new Set();
  const exited = new Set();
  let retired = false;
  return {
    spawn(...args) {
      if (retired) throw new Error('Fixture ACP host is shutting down');
      const proc = spawnFn(...args);
      children.add(proc);
      proc.once('exit', () => exited.add(proc));
      return proc;
    },
    async stop(starting = Promise.resolve()) {
      retired = true;
      await starting;
      const stopped = await Promise.allSettled([...children].filter((proc) => !exited.has(proc)).map(stop));
      const errors = stopped.filter((r) => r.status === 'rejected').map((r) => r.reason);
      if (errors.length) throw new AggregateError(errors, 'Could not stop fixture ACP children');
    },
  };
}

export function acpFixtureStop(host) {
  const processes = acpFixtureProcesses(host.spawnFn);
  host.spawnFn = processes.spawn;
  const starts = new Set();
  const agent = host.agent;
  let retired = false;
  if (agent)
    host.agent = (...args) => {
      if (retired) throw new Error('Fixture ACP host is shutting down');
      const entry = agent.apply(host, args);
      starts.add(entry);
      entry.then(
        () => starts.delete(entry),
        () => starts.delete(entry),
      );
      return entry;
    };
  return () => {
    retired = true;
    const entries = [host.agents, host.isolatedAgents, host.codingAgents].flatMap((pool) => [...(pool?.values() ?? [])]);
    host.closeAll();
    return processes.stop(Promise.allSettled([...starts, ...entries]).then(() => undefined));
  };
}

async function stop(proc) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  await new Promise((resolve, reject) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      proc.off('exit', done);
      proc.off('error', failed);
      resolve(undefined);
    };
    const failed = (error) => {
      clearTimeout(timer);
      proc.off('exit', done);
      proc.off('error', failed);
      reject(error);
    };
    proc.once('exit', done);
    proc.once('error', failed);
    timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (error) {
        failed(error);
      }
    }, 3000);
    try {
      proc.kill('SIGTERM');
    } catch (error) {
      failed(error);
    }
  });
}
