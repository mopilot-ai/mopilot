// Reads Codex's project list without the app's own connection to it: a short-lived `codex app-server`
// is started, asked for project/list, and stopped. The first import of a launch where Codex is
// installed but nothing has started it (D-66) goes through here, so listing projects never costs a
// running Codex.

const IMPORT_TIMEOUT_MS = 20000;

/**
 * @param server an AppServer (electron/harness/codex.cjs) that has not been started
 * @returns the `data` of project/list; rejects with the app-server's own message, or when it exits,
 *   fails to start or does not answer in time. The server is stopped either way.
 */
function listCodexProjects(
  server,
  { timeoutMs = IMPORT_TIMEOUT_MS, clientInfo = { name: 'sage_codex_desktop', title: 'MoPilot', version: '0' } } = {},
) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.listeners.delete(onEvent);
      server.stop();
      err ? reject(err) : resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('Codex did not answer in time')), timeoutMs);
    timer.unref?.();
    const onEvent = (evt) => {
      if (evt.kind === 'exit')
        return finish(
          new Error(`Codex app-server exited (${evt.code ?? evt.signal})${evt.stderr ? `: ${String(evt.stderr).trim().slice(-300)}` : ''}`),
        );
      if (evt.kind === 'error') return finish(new Error(evt.error || 'Codex failed to start'));
      if (evt.kind !== 'message') return;
      const m = evt.msg;
      if (m.id === 'imp:1') {
        if (m.error) return finish(new Error(m.error.message || 'initialize failed'));
        server.send({ method: 'initialized' });
        server.send({ id: 'imp:2', method: 'project/list', params: {} });
      } else if (m.id === 'imp:2') {
        if (m.error) return finish(new Error(m.error.message || 'project/list failed'));
        finish(null, Array.isArray(m.result?.data) ? m.result.data : []);
      }
    };
    server.listeners.add(onEvent);
    try {
      server.start();
      server.send({ id: 'imp:1', method: 'initialize', params: { clientInfo, capabilities: { experimentalApi: true } } });
    } catch (e) {
      finish(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

module.exports = { listCodexProjects, IMPORT_TIMEOUT_MS };
