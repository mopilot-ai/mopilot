// Phone image retrieval after real Mac outbox delivery, negotiated Host framing, native adapters and durable remote transcript projection, for all admitted families.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { FakeNet } from './support/host-wire-kit.ts';
import { setup } from './support/host/claudeKit.ts';
import { open, base, until } from './support/hostCodexKit.ts';
import { rig } from './support/remote-kit.ts';
import { createHostImages } from '../host/src/chatImages.mjs';
import { createProtocol, wireError } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
const require = createRequire(import.meta.url);
const { createRemoteHost } = require('../electron/host/remote.cjs');
const { createRemoteSend } = require('../electron/host/remoteSend.cjs');
const { createRemoteChats } = require('../electron/host/remoteChats.cjs');
const { createOutbox } = require('../electron/host/outbox.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { queueItem } = require('../electron/session/queueItem.cjs');
const { buildAcpTurns } = require('../electron/harness/items/acpTranslator.cjs');
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { readUserImage } = require('../electron/session/userImage.cjs');
const { createPhoneSteps } = require('../electron/app/phoneSteps.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64');
const quiet = { report: () => {} };
async function native(family: string, t: any) {
  if (family === 'claude') return setup();
  const dir = fs.mkdtempSync(path.join(base, 'journey-'));
  if (family === 'codex') return open(dir);
  const agent = path.resolve(import.meta.dirname, 'fixtures/fake-acp-agent.mjs');
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: {
        label: 'Fake',
        bin: process.execPath,
        args: [agent],
        env: { FAKE_ACP_PROFILE: JSON.stringify({ image: true }), FAKE_ACP_STATE: path.join(dir, 'agent') },
      },
    }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {} });
  const sessions = createHostSessions({ paths, env: {}, runtime });
  return {
    dir,
    sessions,
    close: () => {
      sessions.close();
      runtime.close();
    },
  };
}
for (const family of ['claude', 'codex', 'acp'])
  test(`${family}: image enters the native turn, survives cold Mac history and is fetched by a paired phone without inline bytes or paths`, async (t) => {
    const h = await native(family, t);
    const id = randomUUID();
    const chatId = family === 'claude' ? `claude:${id}` : family === 'acp' ? `acp:fake:${id}` : id;
    const epochs = createEpochStore(path.join(h.dir, 'image-epochs.json'), quiet);
    const images = createHostImages({ dir: path.join(h.dir, 'private-images') });
    const protocol = createProtocol({
      runtime: h.sessions.chatRuntime,
      epochs,
      images,
      guard: createGuard({ epochs, ledger: createLedger(path.join(h.dir, 'image-ledger'), quiet) }),
      status: () => ({ running: true }),
    });
    const net = new FakeNet();
    const connections = new WeakMap();
    net.onRequest = (socket, request) => {
      if (request.method === 'ping') return socket.feed({ id: request.id ?? null, result: 'pong' });
      let connection = connections.get(socket);
      if (!connection) {
        connection = protocol.connection(
          (message: any) => socket.feed(message),
          () => 'authenticated-mac',
        );
        connections.set(socket, connection);
      }
      void connection.call(request.method, request.params).then(
        (result: any) => socket.feed({ id: request.id, result }),
        (error: any) => socket.feed({ id: request.id, error: wireError(error) }),
      );
    };
    const tunnel: any = { state: 'online', acquire: () => ({ socketPath: 'fake', release() {} }), onState: () => () => {}, fail() {} };
    const host = createRemoteHost({ id: 'box', tunnel, connect: net.connect, epochOf: () => 1, identity: null });
    const state = new SessionStore();
    const ownerOf = () => ({ hostId: 'box', epoch: 1, folder: h.dir });
    const records: any[] = [];
    const chats = createRemoteChats({
      items: {
        append: (_id: string, ...rows: any[]) => records.push(...rows),
        readAsync: async () => records,
        flush: async () => {},
        size: async () => 0,
        file: () => '',
      },
      hostFor: () => host,
      ownerOf,
      emit: () => {},
      state: () => state,
    });
    const sender = createRemoteSend({
      outbox: createOutbox({ dir: path.join(h.dir, 'mac-outbox') }),
      ownerOf,
      hostFor: () => host,
      rowOf: () => ({ status: 'online' }),
      checkFolder: async () => {},
      state: () => state,
      tray: queueItem,
      subscribed: (key: string) => chats.subscribed(key),
    });
    try {
      await host.connect();
      await chats.follow(chatId);
      const file = path.join(h.dir, 'explicitly-picked.png');
      fs.writeFileSync(file, png);
      sender.begin(chatId, { harness: family === 'acp' ? 'acp:fake' : family });
      const key = randomUUID();
      await sender.enqueue(
        chatId,
        {
          id: key,
          text: 'look at these',
          attachments: [
            { kind: 'image', path: file },
            { kind: 'image', path: file },
          ],
          opts: {},
        },
        null,
      );
      await sender.resume();
      await until(() => records.some((record) => record.t === 'user'));
      await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
      await chats.settled(chatId);
      const user = records.find((record) => record.t === 'user').user;
      assert.equal(user.clientId, key);
      assert.equal(user.content.filter((part: any) => part.type === 'image').length, 2);
      assert.equal(JSON.stringify(user).includes(h.dir), false);
      assert.equal(JSON.stringify(user).includes(png.toString('base64')), false);
      // Rebuild from persisted transcript records, as a Mac reopening the chat does.
      const turns = buildAcpTurns(JSON.parse(JSON.stringify(records)), 'history', h.dir).map((turn: any) => ({
        ...turn,
        sourceSession: 'acp:fake:history',
      }));
      const rows = rowsOf(turns).rows;
      const message = rows.find((row: any) => row.role === 'user');
      assert.equal(message.images, 2);
      assert.equal(message.clientId, key);
      const { row } = await import('../mobile/src/presentation/thread');
      const { withSent, settled } = await import('../mobile/src/presentation/sentMessages');
      assert.equal(
        settled(
          withSent([], [], 'look at these', 'phone-send', [], ['file:///first', 'file:///second'], key),
          rows.map((item: any) => row(item, 'rows')),
        ).length,
        0,
        `${family} saved remote identity settles exactly its phone send`,
      );
      let decodes = 0;
      const steps = createPhoneSteps({
        live: {
          hostOwnership: { get: ownerOf },
          imageHostFor: () => host,
          peerRuntime: {
            readHistory: {
              userImage: (_chat: string, item: string, index: number, check: () => void) =>
                readUserImage({ segments: [{ kind: 'acp:fake', nativeId: 'history' }] }, async () => ({ turns }), item, index, check),
            },
          },
        },
        images: () => ({
          createFromBuffer(data: Buffer) {
            assert.deepEqual(data, png);
            decodes++;
            return { getSize: () => ({ width: 1, height: 1 }), toJPEG: () => Buffer.from('jpeg') };
          },
        }),
      });
      const phone = rig({
        ops: { reachable: () => true, items: async () => ({ itemsShape: 'rows', items: rows }), userImage: steps.userImage },
      }).phone('p1');
      const snapshot = await phone.ask('chat.follow', { chatId });
      assert.equal(snapshot.ok, true);
      for (const index of [0, 1]) {
        const requestId = `image-${index}`;
        await phone.ask('messages.image', { chatId, itemId: message.id, index }, requestId);
        const reply = await until(() => phone.inbox.find((entry) => entry.inReplyTo === requestId));
        assert.equal(reply.result.data, Buffer.from('jpeg').toString('base64'));
      }
      assert.equal(decodes, 2);
    } finally {
      sender.dispose();
      chats.dispose();
      host.dispose();
      await h.close();
    }
  });
