// Owns headless Node subprocesses for native process tests: ready identities, bounded startup and cleanup on every exit.
import { spawn } from 'node:child_process';
import type { TestContext } from 'node:test';

export const LEAF = `
  // Fail closed after the test's 30s timeout, even if all cleanup owners disappear.
  setTimeout(() => process.exit(1), 60_000).unref();
  process.on('disconnect', () => process.exit(0));
  process.send({ pid: process.pid, ppid: process.ppid });`;

export const TREE = `
  setTimeout(() => process.exit(1), 60_000).unref();
  const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(LEAF)}], {
    windowsHide: true, detached: process.platform === 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  child.once('message', (leaf) => process.send({ pid: process.pid, ppid: process.ppid, child: leaf }));
  child.once('error', () => process.exit(1));
  child.once('exit', () => { if (!process.connected) process.exit(0); });
  process.on('disconnect', () => {
    child.kill('SIGKILL');
    if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
  });`;

export interface ProcessIdentity {
  pid: number;
  ppid: number;
  child?: ProcessIdentity;
}

export function ownedNode(
  t: TestContext,
  { source = LEAF, timeout = 5000, executable = process.execPath }: { source?: string; timeout?: number; executable?: string } = {},
) {
  // Custom sources may ignore disconnect; they also need a self-exit if their test owner disappears.
  const guardedSource = `${source}\n;setTimeout(() => process.exit(1), 60_000).unref();`;
  const processChild = spawn(executable, ['-e', guardedSource], {
    windowsHide: true,
    // CREATE_NO_WINDOW can still allocate a console host. DETACHED_PROCESS leaves this fixture without a console.
    // Keep the IPC reference and explicit teardown: detaching must not let the fixture escape its test's ownership.
    detached: process.platform === 'win32',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  // With ignored stdio and IPC, Node can emit exit without a subsequent close. No pipe output needs draining.
  const exited = new Promise<void>((resolve) => {
    processChild.once('exit', () => resolve());
    // A failed spawn has no exit event. An error after a successful spawn still waits for that process to exit.
    processChild.once('error', () => {
      if (processChild.pid === undefined) resolve();
    });
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= new Promise<void>((resolve) => {
      const deadline = setTimeout(() => processChild.kill('SIGKILL'), timeout);
      void exited.then(() => {
        clearTimeout(deadline);
        resolve();
      });
      if (processChild.connected) processChild.disconnect();
      else if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill('SIGKILL');
    });
    return stopping;
  };
  t.after(stop);
  const ready = new Promise<ProcessIdentity>((resolve, reject) => {
    const finish = (error?: Error, identity?: ProcessIdentity) => {
      clearTimeout(deadline);
      processChild.off('message', message);
      processChild.off('error', failed);
      processChild.off('exit', ended);
      if (error) reject(error);
      else resolve(identity!);
    };
    const message = (identity: ProcessIdentity) => finish(undefined, identity);
    const failed = (error: Error) => finish(error);
    const ended = (code: number | null) => finish(new Error(`fixture exited before ready (${code})`));
    const deadline = setTimeout(() => finish(new Error('fixture did not become ready')), timeout);
    processChild.once('message', message);
    processChild.once('error', failed);
    processChild.once('exit', ended);
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });
  return { process: processChild, ready, exited, stop };
}
