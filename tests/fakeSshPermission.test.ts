// The fake SSH tunnel must forward permission changes to the same resident Host that owns starts, sends and subscriptions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

for (const harness of ['claude', 'codex']) {
  test(`fake SSH forwards ${harness} permission changes before the next resident turn`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
    const address = (name: string) => (process.platform === 'win32' ? `\\\\.\\pipe\\fp-${randomUUID()}` : path.join(dir, name));
    const resident = address('r'),
      tunnel = address('t');
    const ready = path.join(dir, 'ready.cjs');
    fs.writeFileSync(
      ready,
      `const net = require('node:net'); const create = net.createServer.bind(net); net.createServer = (...a) => { const s = create(...a); s.once('listening', () => process.send?.('ready')); return s; };`,
    );
    const children: ReturnType<typeof spawn>[] = [];
    let client: net.Socket | undefined;
    t.after(async () => {
      client?.destroy();
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
        }),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const launch = async (script: string, args: string[] = []) => {
      const child = spawn(
        process.execPath,
        ['--require', ready, fileURLToPath(new URL(`./e2e/fixtures/fake-ssh/${script}`, import.meta.url)), ...args],
        {
          env: {
            ...process.env,
            FAKE_HOST_ROOT: dir,
            FAKE_HOST_CHATS_SOCK: resident,
            FAKE_HOST_WIRE_SOCK: '',
            FAKE_HOST_OFFLINE: '',
            FAKE_HOST_LOG: path.join(dir, 'calls'),
          },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      children.push(child);
      let errors = '';
      child.stderr?.on('data', (chunk) => (errors += String(chunk)));
      await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(([code]) => {
          throw new Error(`${script} exited ${code}: ${errors}`);
        }),
      ]);
    };
    await launch('host-chats.cjs');
    await launch('ssh', ['-N', '-L', `${tunnel}:/h/host.sock`, '--', 'me@box']);
    client = net.connect(tunnel);
    await once(client, 'connect');
    let buffer = '',
      id = 0;
    const waiting = new Map<number, (reply: any) => void>();
    client.setEncoding('utf8');
    client.on('data', (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const reply = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        waiting.get(reply.id)?.(reply);
        waiting.delete(reply.id);
      }
    });
    const request = (method: string, params: object) =>
      new Promise<any>((resolve) => {
        const key = ++id;
        waiting.set(key, resolve);
        client!.write(`${JSON.stringify({ id: key, method, params })}\n`);
      });
    // the fixture holds the real Host's rule: a versioned request is refused until hello came first on the connection
    assert.equal((await request('host.hello', {})).error, undefined);
    const scope = { chatId: 'c', epoch: 1 };
    const start = await request('chat.start', { ...scope, harness, key: 'start', text: 'first', permission: 'read-only' });
    assert.equal(start.error, undefined);
    const permit = await request('chat.permit', { ...scope, key: 'permit', value: 'full-access' });
    assert.equal(permit.error, undefined, 'permission changes must reach the resident Host');
    assert.equal(permit.result.result.changed, true);
    const snapshot = await request('chat.subscribe', scope);
    assert.equal(snapshot.result.subscribed, true);
    const send = await request('chat.send', { ...scope, key: 'send', text: 'changed-pick' });
    assert.equal(send.error, undefined);
    assert.equal(send.result.result.turnId, 't2');
    const denied = await request('chat.permit', { ...scope, key: 'bad-permit', value: 'not-a-mode' });
    assert.equal(denied.error.code, 'mode_unavailable', 'a resident refusal must not become a successful mode change');
  });
}
