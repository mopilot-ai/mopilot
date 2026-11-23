// Electron main dev-previews wiring unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, flush, calls } from './fixture';

export function registerDevPreviewsCases() {
  test("dev-server previews: the shim's chats and folders, the servers' env, auto-open and exit notes, and the start card", async () => {
    {
      const h = await loadMain({
        before: (h) => {
          h.mods['electron/capabilities/browser/host.cjs'] = { BrowserTabs: h.cls('BrowserTabs') };
          h.mods['electron/capabilities/browser/hostTools.cjs'] = {
            registerBrowserTools: mock.fn(),
            inAppBrowserEnabled: mock.fn((on: any) => (on('shared.browser.parityTools') ? true : 'off')),
          };
        },
      });
      await h.ready();
      const change = h.one('BrowserTabs').change;
      const flags = h.mod('platform/flags.cjs').isEnabled;
      // the in-app browser tools are checked on every call
      const [[, hostTools]] = calls(h.mod('capabilities/browser/hostTools.cjs').registerBrowserTools);
      assert.equal(hostTools.enabled(), true);
      // the agent's cursor on the page follows its flag
      const cursor = h.one('BrowserTabs').opts.cursor;
      assert.equal(cursor.enabled(), true);
      flags.mock.mockImplementationOnce((k: string) => k !== 'shared.browser.agentCursor');
      assert.equal(cursor.enabled(), false);
      await flush();
      const shim = h.one('BrowserShim');
      const previews = h.one('DevPreviews');
      const [[, tools]] = calls(h.mod('capabilities/browser/devPreview.cjs').registerPreviewTools);
      const openInPane = h.mod('capabilities/browser/devPreview.cjs').paneOpener.mock.calls[0].result;
      // the shim's env is added to every child's env while previews are on
      const [[extra]] = calls(h.mod('platform/env.cjs').setExtraEnv);
      assert.deepEqual(extra({ A: '1' }), { BROWSER: 'shim:null', A: '1' });
      assert.equal(tools.enabled(), true);
      assert.equal(await shim.opts.open('c1', 'http://localhost:5173'), true);
      assert.deepEqual(calls(openInPane).at(-1), ['c1', 'http://localhost:5173', { ask: true }]);
      openInPane.mock.mockImplementationOnce(async () => null);
      assert.equal(await shim.opts.open('c1', 'http://localhost:5173'), false, 'the user declined the tab');
      assert.deepEqual(previews.opts.chatEnv('c1'), { BROWSER: 'shim:c1' });
      assert.deepEqual(previews.opts.env(), { PATH: '/bin' });
      flags.mock.mockImplementation((k: string) => k !== 'shared.browser.devPreview');
      assert.equal(tools.enabled(), 'Dev-server previews are turned off.');
      assert.equal(await shim.opts.open('c1', 'http://localhost:5173'), false);
      assert.deepEqual(previews.opts.chatEnv('c1'), {});
      assert.deepEqual(extra({ A: '1' }), {});
      flags.mock.mockImplementation(() => true);

      // the chat running a turn, with its current segment's project folder
      const sessions = h.one('SessionStore');
      const turns: any = { a: 'running', b: 'idle', c: 'awaitingUser', d: 'running' };
      sessions.all = () => Object.keys(turns);
      sessions.get = (id: string) => ({ turn: turns[id] });
      h.one('ChatsStore').record = (id: string) => {
        if (id === 'd') throw new Error('no record');
        return {
          segments: [
            { kind: 'codex', nativeId: 'old' },
            id === 'c' ? { kind: 'other', nativeId: 'x' } : { kind: 'codex', nativeId: `n-${id}` },
          ],
        };
      };
      h.one('CodexAdapter').folderOf = async (id: string) => `/work/${id}`;
      assert.deepEqual(await shim.opts.running(), [
        { chatId: 'a', cwd: '/work/n-a' },
        { chatId: 'c', cwd: null },
        { chatId: 'd', cwd: null },
      ]);
      assert.equal(await tools.projectOf('a'), '/work/n-a');

      // a server that asked to open: its tab is remembered; one that didn't, or whose tab failed, is left alone
      const s: any = { autoOpen: true, chatId: 'c1', url: 'http://localhost:3000', tabId: 't0' };
      previews.opts.onReady(s);
      await flush();
      assert.deepEqual(calls(openInPane).at(-1), ['c1', 'http://localhost:3000', { tabId: 't0' }]);
      assert.equal(s.tabId, 'tab-1');
      openInPane.mock.mockImplementationOnce(async () => {
        throw new Error('closed');
      });
      previews.opts.onReady(s);
      const n = openInPane.mock.callCount();
      previews.opts.onReady({ autoOpen: false });
      await flush();
      assert.equal(openInPane.mock.callCount(), n);
      assert.equal(s.tabId, 'tab-1');
      // a server that exited on its own is noted in the chat's browser changes
      previews.opts.onExit({ status: 'running', chatId: 'c1', id: 'p1', exitCode: 1 });
      previews.opts.onExit({ status: 'running', chatId: 'c1', id: 'p2', exitCode: null });
      previews.opts.onExit({ status: 'stopped', chatId: 'c1', id: 'p3', exitCode: 0 });
      assert.deepEqual(calls(change), [
        ['c1', 'preview_exited p1 with code 1: see preview_logs'],
        ['c1', 'preview_exited p2: see preview_logs'],
      ]);

      // starting a server asks with its own card
      const broker = h.inst.computerUse[0].broker;
      h.one('ChatController').ref = () => ({ kind: 'claude', id: 'n' });
      broker.ask.mock.mockImplementation(async () => ({ decision: 'allow' }));
      // the tool call's signal goes to the card, which an aborted call withdraws (#1865)
      const { signal } = new AbortController();
      assert.equal(await tools.confirm({ chatId: 'c1', signal }, { command: 'npm run dev', cwd: '/w' }), true);
      assert.deepEqual(calls(broker.ask).at(-1), [
        'c1',
        'devServer',
        { harness: 'claude', command: 'npm run dev', cwd: '/w', tool: 'browser_preview_start' },
        { signal },
      ]);
      broker.ask.mock.mockImplementation(async () => null);
      assert.equal(await tools.confirm({ chatId: 'c1' }, { command: 'npm run dev', cwd: '/w' }), false);
      const grants = h.one('OriginGrants');
      grants.anchor = mock.fn((ctx: any) => `anchor:${ctx.chatId}`);
      assert.equal(tools.anchor({ chatId: 'c1' }), 'anchor:c1');
      // will-quit still cleans up when the before-quit gate was skipped.
      h.app.emit('will-quit');
      assert.equal(previews.stopAll.mock.callCount(), 1);
      assert.equal(shim.close.mock.callCount(), 1);
    }
  });
}
