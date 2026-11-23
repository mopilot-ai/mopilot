// An isolated stdio fake-CLI unit fixture; it uses scratch files and no application windows, logins or desktop grants.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

export function fakeCli(t: TestContext, family: 'claude' | 'codex') {
  const root = mkdtempSync(path.join(tmpdir(), `fake-${family}-control-`));
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL(`../e2e/fixtures/fake-${family}.mjs`, import.meta.url)),
      ...(family === 'claude' ? ['--input-format', 'stream-json', '--output-format', 'stream-json'] : ['app-server']),
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const messages: any[] = [];
  const waiting = new Set<() => void>();
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    messages.push(JSON.parse(line));
    for (const notify of waiting) notify();
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const receive = (predicate: (message: any) => boolean) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(check);
        reject(new Error(`fake ${family} did not produce the expected protocol message: ${stderr}`));
      }, 5000);
      const check = () => {
        const found = messages.find(predicate);
        if (!found) return;
        clearTimeout(timer);
        waiting.delete(check);
        resolve(found);
      };
      waiting.add(check);
      check();
    });
  let id = 0;
  const request = async (method: string, params: unknown) => {
    const requestId = ++id;
    send({ id: requestId, method, params });
    const response = await receive((message) => message.id === requestId);
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  };
  t.after(async () => {
    lines.close();
    if (child.exitCode === null)
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, child, messages, send, receive, request };
}
