// Foreground package commands share the quiet ChildProcess owner and expose a read-only log instead of authorizing signals from a PTY PID.
/** The manager's foreground output adapter; `quiet` still controls presentation and Update all visibility. */
function packageOutput(spawn) {
  const running = new Map();
  return {
    spawn(id, opts, handlers) {
      if (running.has(id)) throw new Error('This package command is still retiring.');
      const entry = { handle: null };
      running.set(id, entry);
      try {
        entry.handle = spawn(
          opts.command,
          { cwd: opts.cwd, env: opts.env },
          {
            onData: handlers.onData,
            onStopping: handlers.onStopping,
            onExit(event) {
              if (running.get(id) === entry) running.delete(id);
              handlers.onExit(event);
            },
          },
        );
      } catch (error) {
        if (running.get(id) === entry) running.delete(id);
        throw error;
      }
    },
    kill(id) {
      running.get(id)?.handle?.kill();
    },
    // Automatic package commands are noninteractive; the UI labels their shared view as read-only output.
    write() {
      /* Package commands have closed stdin; the UI exposes their read-only log. */
    },
    resize() {
      /* Pipes have no terminal dimensions. */
    },
  };
}

module.exports = { packageOutput };
