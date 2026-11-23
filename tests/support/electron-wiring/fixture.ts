// electron/main.cjs: how main wires chat-to-chat messaging (PeerRuntime and its native readers, gate and
// journal publishing) and the in-app browser's tabs, popups and tool visibility to windows, chats and
// harness adapters, over fakes (tests/support/electron-main-harness.ts).
import { mock, after } from 'node:test';
import { createRequire } from 'node:module';
import { loadMain, unloadMain, flush, type Harness } from '../electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
export const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);

/** main with the peer modules replaced, so the options it passes them can be called directly */
export async function peerMain(journal: any[] = [], early?: any) {
  const h = await loadMain({
    before: (h) => {
      h.mods['electron/session/peerRuntime.cjs'] = {
        PeerRuntime: h.cls('PeerRuntime', (o: any) => {
          // the journal publishes while it opens, before main is ready to announce deliveries
          if (early) o.publish({ messages: [early] });
          return { service: { data: { messages: journal } }, userTurn: mock.fn((id: string, item: any) => ({ ...item, userTurnOf: id })) };
        }),
      };
      h.mods['electron/session/peerGate.cjs'] = { createPeerGate: mock.fn((o: any) => ({ gateOpts: o })) };
      h.mods['electron/session/peerReceipts.cjs'] = { createPeerReceiptReader: mock.fn((o: any) => ({ receiptOpts: o })) };
      h.mods['electron/session/peerTranscript.cjs'] = {
        readPeerTranscript: mock.fn(async (rec: any, options: any, reader: any) => ({ transcript: rec, options, reader })),
        readPeerReference: mock.fn(async (rec: any, reader: any) => ({ reference: rec, reader })),
        peerHistoryReader: mock.fn((chats: any, nativeReader: any) => async (id: string) => ({
          history: chats.records.get(id),
          reader: nativeReader(),
        })),
      };
      h.mods['electron/session/peerNativeHistory.cjs'] = {
        createPeerNativeReader: mock.fn((o: any) => ({ nativeOpts: o })),
        claudePeerSource: createRequire(import.meta.url)('../../../electron/session/peerNativeHistory.cjs').claudePeerSource,
        acpPeerSource: createRequire(import.meta.url)('../../../electron/session/peerNativeHistory.cjs').acpPeerSource,
      };
      h.mods['electron/capabilities/browser/host.cjs'] = { BrowserTabs: h.cls('BrowserTabs') };
      h.mods['electron/capabilities/browser/windows.cjs'] = { BrowserWindows: h.cls('BrowserWindows') };
      h.mods['electron/capabilities/browser/hostTools.cjs'] = {
        registerBrowserTools: mock.fn(),
        inAppBrowserEnabled: mock.fn(() => 'in-app'),
      };
      h.mods['electron/capabilities/browser/handoff.cjs'] = {
        chromeHandoff: mock.fn((o: any) => async (request: any) => ({ handoffOpts: o, request })),
        cancelChromeHandoff: mock.fn((o: any, request: any, sender: any) => ({ cancelOpts: o, request, sender })),
        // the route main computes, by the channel it says runs
        chatHandoffRoute: mock.fn((o: any) => o.channel),
      };
      h.mods['electron/capabilities/anchor.cjs'] = { chatAnchorOf: mock.fn((chatId: string) => `anchor-${chatId}`) };
      h.mods['electron/capabilities/visibility.cjs'] = {
        ToolVisibility: h.cls('ToolVisibility', () => ({ forHost: mock.fn((o: any) => ({ host: o })) })),
      };
      h.mods['electron/session/voice.cjs'] = {
        voiceWriter: mock.fn(() => null),
        startVoice: mock.fn(async (deps: any, params: any) => ({ voice: params, deps })),
      };
    },
  });
  await h.ready();
  return h;
}
export const runtime = (h: Harness) => h.one('PeerRuntime').opts;

export { loadMain, flush, type Harness };
