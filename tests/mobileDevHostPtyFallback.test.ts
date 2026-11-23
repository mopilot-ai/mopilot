// The dev host's terminal logs it when node-pty cannot start a shell and the phone's shell runs on plain pipes instead.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPhone, until } from './support/mobileStack.ts';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-pty-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('a shell node-pty cannot start is logged with the reason and still answers the phone on plain pipes', async () => {
  const lines: string[] = [];
  const host = await startHost({
    dir: path.join(scratch, 'one'),
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: (l: string) => lines.push(l),
    sleep: async () => undefined,
    ptyOptions: {
      shell: '/bin/sh',
      repair: () => null,
      load: () => ({
        spawn: () => {
          throw new Error('posix_spawnp failed.');
        },
      }),
    },
  });
  after(() => host.stop());
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr, 'Test iPhone');
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);

  const { chats } = await phone.ask('chats.recent', { limit: 10, archived: false });
  const chatId = chats[0].id;
  await phone.ask('chat.follow', { chatId });
  await phone.ask('pty.open', { chatId, stream: 's1', cols: 80, rows: 24 });
  await phone.ask('pty.write', { stream: 's1', data: 'echo pipes-$((40+2))\n' });
  await until(
    () =>
      phone
        .eventsOf('pty.data')
        .map((e: any) => Buffer.from(e.data, 'base64').toString())
        .join('')
        .includes('pipes-42'),
    'the shell output on plain pipes',
  );
  await phone.ask('pty.close', { stream: 's1' });
  assert.ok(lines.some((l) => l.includes('terminal: node-pty could not start a shell (posix_spawnp failed.); using plain pipes')));
});
