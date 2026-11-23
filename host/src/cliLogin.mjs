// `mopilot-host login <harness>`: asks the running Host to start the agent's sign-in, shows the links and codes it reports, and ends when it is done, failed, expired or cancelled (Ctrl-C cancels it).
import readline from 'node:readline';
import { callHost } from './server.mjs';

/**
 * @param {{ paths: { socketPath: string }, harness?: string, methodId?: string, out: (l: string) => void, err: (l: string) => void, signals: NodeJS.Process, stdin?: (NodeJS.ReadableStream & { isTTY?: boolean }) | null, ports: { openExternal: (url: string) => unknown }, pollMs: number, usage: string }} o
 * @returns {Promise<number>}
 */
export async function loginCommand({ paths, harness, methodId, out, err, signals, stdin, ports, pollMs, usage }) {
  if (!harness) {
    err(usage);
    return 1;
  }
  const started = await callHost(paths.socketPath, 'login', { harness, methodId });
  if (!started || started.error) {
    err(started?.error ?? 'No Host is running here. Start it with `mopilot-host serve`.');
    return 1;
  }
  // Ctrl-C stops the sign-in on the Host; the loop below then reports it cancelled
  const cancel = () => void callHost(paths.socketPath, 'loginCancel', { harness });
  signals.once('SIGINT', cancel);
  // at a terminal, a line the person types goes to the sign-in (a pipe or service never waits on input): Claude Code asks for the code its page shows to be pasted
  const typed = stdin?.isTTY ? readline.createInterface({ input: stdin }) : null;
  typed?.on('line', (text) => void callHost(paths.socketPath, 'loginInput', { harness, text }));
  try {
    const shown = new Set();
    for (;;) {
      const status = (await callHost(paths.socketPath, 'loginStatus', { harness }))?.result;
      if (!status) {
        err('The Host stopped answering.');
        return 1;
      }
      for (const link of status.links) if (!shown.has(link)) shown.add(link), await ports.openExternal(link);
      for (const code of status.codes) if (!shown.has(code)) shown.add(code), out(`Enter this code: ${code}`);
      if (status.state === 'done') return out('Signed in.'), 0;
      // an expired code ends the command too: running it again gets a new one
      if (status.state === 'failed' || status.state === 'expired') return err(status.error), 1;
      if (status.state === 'cancelled') return err('Sign-in was cancelled.'), 1;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    typed?.close();
    signals.off('SIGINT', cancel);
  }
}
