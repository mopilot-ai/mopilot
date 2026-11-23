// Phone history image RPC crosses the negotiated Host store and real Electron image decoder, retaining repeated positions without putting bytes or paths in follow snapshots.
import path from 'node:path';
import { test, expect } from './fixtures/app';

// A known Windows failure, run there and expected to fail: the spec runs the Host's image store (host/src/chatImages.mjs) in
// the app's process, which refuses to save the image on Windows, where no Host runs (docs/host.md). The desktop side it also
// covers ships on Windows, so it runs there rather than skipping.
test.fail(process.platform === 'win32', "the Host's image store, run in the app on Windows where no Host runs, refuses to save the image");
for (const family of ['claude', 'codex', 'acp']) {
  test(`${family}: uploaded user images survive history projection and open at thumbnail and full size`, async ({ harness }) => {
    const entry = path.resolve(__dirname, '../../electron/app/phoneSteps.cjs');
    const result = await harness.app.evaluate(
      async (electron, { entry, family }) => {
        const require = process.getBuiltinModule('module').createRequire(entry);
        const fs = process.getBuiltinModule('fs');
        const path = process.getBuiltinModule('path');
        const os = process.getBuiltinModule('os');
        const { EventEmitter } = process.getBuiltinModule('events');
        const { createPhoneSteps } = require(entry);
        const { uploadImages } = require('../host/imageTransfer.cjs');
        const { createHostImages } = require('../../host/src/chatImages.mjs');
        const { createProtocol } = require('../../host/src/protocol.mjs');
        const { createEpochStore } = require('../../host/src/epochs.mjs');
        const { createGuard } = require('../../host/src/guard.mjs');
        const { createLedger } = require('../../host/src/ledger.mjs');
        const { helloParams } = require('../../shared/host/schema.mjs');
        const { scopeHostPictures } = require('../../shared/host/images.mjs');
        const { userInput } = require('../../shared/userInput.mjs');
        const { buildAcpTurns } = require('../harness/items/acpTranslator.cjs');
        const { rowsOf } = require('../capabilities/browser/chromePanelLive.cjs');
        const { readUserImage } = require('../session/userImage.cjs');
        const { RemoteService } = require('../remote/service.cjs');
        const { SessionStore } = require('../session/state.cjs');
        const { createMemoryLink } = require('../../shared/remote/transport.mjs');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-message-images-'));
        const bus = new EventEmitter();
        const quiet = { report() {} };
        const epochs = createEpochStore(path.join(dir, 'epochs'), quiet);
        const images = createHostImages({ dir: path.join(dir, 'host-images') });
        let modelImages = 0;
        const runtime = {
          host: Object.assign(bus, { cancel() {} }),
          permit: () => true,
          familyOf: () => family,
          prepare: async () => {},
          async send(p: any) {
            modelImages = p.attachments.length;
            const user = { id: `u-${p.clientId}`, clientId: p.clientId, content: userInput(p.text, p.attachments) };
            bus.emit('event', { kind: 'turnStart', key: p.key, turnId: 'native-turn', user });
            return { turnId: 'native-turn' };
          },
        };
        const protocol = createProtocol({
          runtime,
          images,
          epochs,
          guard: createGuard({ epochs, ledger: createLedger(path.join(dir, 'ledger'), quiet) }),
          status: () => ({ running: true }),
        });
        const frames: any[] = [];
        const connection = protocol.connection(
          (frame: any) => frames.push(frame),
          () => 'paired-mac',
        );
        const host = { speaks: () => true, state: () => 'online', call: (method: string, p: any) => connection.call(method, p) };
        const chatId =
          family === 'claude' ? 'claude:00000000-0000-4000-8000-000000000b1c' : family === 'acp' ? 'acp:fake:picture' : 'picture';
        let service: any;
        try {
          await connection.call('host.hello', helloParams());
          const file = path.join(dir, 'picked.png');
          const picture = electron.nativeImage.createFromDataURL(
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          );
          if (picture.isEmpty()) throw new Error('The fixture image did not decode.');
          fs.writeFileSync(file, picture.toPNG());
          const ids = await uploadImages({
            host,
            chatId,
            epoch: 1,
            attachments: [
              { kind: 'image', path: file },
              { kind: 'image', path: file },
            ],
            check() {},
          });
          await connection.call('chat.start', {
            chatId,
            epoch: 1,
            key: 'original-picture-message',
            harness: family === 'acp' ? 'acp:fake' : family,
            text: 'look',
            images: ids,
          });
          await connection.call('chat.subscribe', { chatId, epoch: 1 });
          const snapshot = frames.find((message: any) => message.frame?.t === 'hello').frame.snapshot;
          const raw = snapshot.items.find((item: any) => item.t === 'user');
          const user = scopeHostPictures(raw.user, 'box');
          const turns = buildAcpTurns([{ t: 'user', turnId: raw.turnId, user }], 'history', dir).map((turn: any) => ({
            ...turn,
            sourceSession: 'acp:fake:history',
          }));
          const rows = rowsOf(turns).rows;
          const steps = createPhoneSteps({
            live: {
              hostOwnership: { get: () => ({ hostId: 'box', epoch: 1 }) },
              imageHostFor: () => host,
              peerRuntime: {
                readHistory: {
                  userImage: (_chat: string, item: string, index: number, check: () => void) =>
                    readUserImage({ segments: [{ kind: 'acp:fake', nativeId: 'history' }] }, async () => ({ turns }), item, index, check),
                },
              },
            },
            images: () => electron.nativeImage,
          });
          service = new RemoteService({
            ops: {
              state: new SessionStore(),
              reachable: () => true,
              cardsOf: async () => [],
              read: async () => ({ chatId }),
              items: async () => ({ itemsShape: 'rows', items: rows }),
              userImage: steps.userImage,
            },
          });
          const link = createMemoryLink();
          link.addPair('phone');
          service.attach(link.mac);
          const phone = link.phone('phone');
          let sequence = 0;
          const ask = (method: string, params: any) =>
            new Promise<any>((resolve, reject) => {
              const id = `image-${++sequence}`;
              const off = phone.onMessage((reply: any) => {
                if (reply.inReplyTo === id) {
                  off();
                  reply.ok ? resolve(reply.result) : reject(new Error(reply.error.message));
                }
              });
              void phone.send({ id, t: 1, kind: 'request', method, params }).catch(reject);
            });
          const followed = await ask('chat.follow', { chatId });
          const pictures: any[] = [];
          for (const [index, maxSide] of [
            [0, 360],
            [1, 1024],
          ])
            pictures.push(await ask('messages.image', { chatId, itemId: rows[0].id, index, maxSide }));
          return {
            modelImages,
            count: followed.items[0].images,
            privatePath: JSON.stringify(followed).includes(dir),
            inlineBytes: JSON.stringify(followed).includes(ids[0]),
            decoded: pictures.map((p) => !electron.nativeImage.createFromDataURL(`data:image/jpeg;base64,${p.data}`).isEmpty()),
            sizes: pictures.map((p) => p.data.length),
            clientId: user.clientId,
          };
        } finally {
          service?.detach();
          connection.close();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      { entry, family },
    );
    expect(result.modelImages).toBe(2);
    expect(result.count).toBe(2);
    expect(result.privatePath).toBe(false);
    expect(result.inlineBytes).toBe(false);
    expect(result.decoded).toEqual([true, true]);
    expect(result.sizes.every((size: number) => size < 240_000)).toBe(true);
    expect(result.clientId).toBe('original-picture-message');
  });
}
