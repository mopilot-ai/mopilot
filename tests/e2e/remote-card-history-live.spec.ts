// A slow real cardTurns boundary must not block first-delta delivery in Electron; the ready card fills in afterward.
import path from 'node:path';
import { test, expect } from './fixtures/app';

test('live text passes a slow card-history read and the card fills in at the current revision', async ({ harness }) => {
  const entry = path.resolve(__dirname, '../../electron/remote/service.cjs');
  const result = await harness.app.evaluate(async (_electron, serviceEntry) => {
    const require = process.getBuiltinModule('module').createRequire(serviceEntry);
    const { RemoteService } = require(serviceEntry);
    const { SessionStore } = require('../session/state.cjs');
    const { createOpenReads } = require('../app/chromePanelOpenRead.cjs');
    const { createMemoryLink } = require('../../shared/remote/transport.mjs');
    let release!: (value: any) => void;
    const history = new Promise((resolve) => {
      release = resolve;
    });
    const opened = createOpenReads({ live: {}, reachable: () => true, historyOf: { recent: () => history } });
    const ops: any = {
      state: new SessionStore({ publish: (patch: any) => service.onSessionPatch(patch) }),
      reachable: () => true,
      cardsOf: async () => [],
      items: async () => ({ itemsShape: 'rows', items: [] }),
    };
    const service = new RemoteService({ ops });
    const link = createMemoryLink();
    link.addPair('phone');
    service.attach(link.mac);
    const phone = link.phone('phone');
    let followed!: (value: any) => void;
    let delta!: (value: any) => void;
    let cards!: (value: any) => void;
    const snapshot = new Promise<any>((resolve) => {
      followed = resolve;
    });
    const firstDelta = new Promise<any>((resolve) => {
      delta = resolve;
    });
    const readyCards = new Promise<any>((resolve) => {
      cards = resolve;
    });
    phone.onMessage((m: any) => {
      if (m.inReplyTo === 'follow') followed(m);
      if (m.ev === 'items.delta') delta(m);
      if (m.ev === 'cards.changed') cards(m);
    });
    const within = async (promise: Promise<any>, ms: number) => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        return await Promise.race([
          promise,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
    };
    try {
      await phone.send({ id: 'follow', t: 1, kind: 'request', method: 'chat.follow', params: { chatId: 'chat' } });
      if (!(await within(snapshot, 2000))?.ok) throw new Error('Initial follow failed');
      ops.cardsOf = async () =>
        (await opened.cardTurns('chat')).turns.map((turn: any) => ({ id: turn.id, version: turn.id, title: 'Question' }));
      const began = Date.now();
      ops.state.patch('chat', { approvals: [{ id: 'card' }] });
      service.onFeedEvent({ ev: 'items.delta', chatId: 'chat', itemId: 'reply', field: 'text', text: 'hello' });
      const event = await within(firstDelta, 250);
      const deltaMs = Date.now() - began;
      ops.state.patch('chat', { turn: 'running' });
      release({ turns: [{ id: 'card' }] });
      const fill = await within(readyCards, 2000);
      return { deltaBeforeHistory: !!event, deltaMs, cardId: fill?.cards[0]?.id, rev: fill?.rev, currentRev: ops.state.get('chat').rev };
    } finally {
      release({ turns: [] });
      service.detach();
    }
  }, entry);
  console.log(`Card history protocol timing: ${JSON.stringify(result)}`);
  expect(result.deltaBeforeHistory).toBe(true);
  expect(result.cardId).toBe('card');
  expect(result.rev).toBe(result.currentRev);
});
