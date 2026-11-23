// Browser-panel main-owned-views unit cases with a shared recording fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  window,
  act,
  fixture,
  root,
  container,
  event,
  setup,
  notice,
  button,
  click,
  change,
  submit,
  rerender,
  clearRoot,
  noticeClick,
} from './fixture';

export function registerMainOwnedViewsCases() {
  const viewState = (patch: any = {}) => ({
    url: 'https://task.test/start',
    title: 'Task',
    canGoBack: true,
    canGoForward: false,
    loading: false,
    zoom: 1,
    ...patch,
  });
  async function viewSetup(options: any = {}) {
    fixture.flags = { 'shared.browser.viewTabs': true };
    try {
      await setup({
        ...options,
        handlers: {
          'view.bind': async () => ({ id: 10, state: viewState() }),
          'view.bounds': async () => true,
          'view.nav': async () => {},
          ...options.handlers,
        },
      });
    } finally {
      fixture.flags = {};
    }
    await act(async () => {});
  }
  const viewCalls = (name: string) => fixture.calls.filter((c: any[]) => c[0] === `view.${name}`).map((c: any[]) => c.slice(1));
  async function viewEvent(e: any) {
    await act(async () => fixture.callbacks.get('viewEvent')?.({ id: 10, state: null, detail: null, ...e }));
  }
  const stageOf = () => container.querySelector<HTMLElement>('.browser-view')!;
  function placeStage(r: { x: number; y: number; width: number; height: number }) {
    (stageOf() as any).getBoundingClientRect = () => ({ left: r.x, top: r.y, width: r.width, height: r.height });
  }

  test('view: a placeholder binds the pane tab to its view in main, and the panel follows the page from main', async () => {
    await viewSetup();
    assert.equal(container.querySelector('webview'), null);
    assert.equal(stageOf().dataset.view, '10');
    assert.deepEqual(viewCalls('bind'), [
      ['tab', { chatId: 'agent-chat', chat: 'agent-chat', tabKey: null, url: 'https://task.test/start', partition: 'persist:browser' }],
    ]);
    // bound: the panel knows its page as it knew a guest (page state, the agent's tab), but reports no layer
    assert.deepEqual(
      fixture.calls.filter((c: any[]) => ['pageState', 'attach', 'layer'].includes(c[0])),
      [
        ['pageState', 10],
        ['attach', 'agent-chat', 10, undefined],
      ],
    );
    // main's events: another view's are ignored; this view's update the address and history
    await viewEvent({ id: 11, type: 'did-navigate', state: viewState({ url: 'https://other.test/' }) });
    await viewEvent({ type: 'did-navigate', state: viewState({ url: 'https://task.test/next', title: 'Next' }) });
    assert.equal(fixture.state.paneTabs[0].url, 'https://task.test/next');
    assert.equal(button('Back').disabled, false);
    assert.equal(button('Forward').disabled, true);
    // the toolbar goes to main
    await click('Back');
    await click('Reload');
    await viewEvent({ type: 'did-start-loading', state: viewState({ loading: true }) });
    await click('Stop');
    assert.ok(fixture.calls.some((call: any[]) => call[0] === 'stopLoading' && call[1] === 10));
    await change('input', 'https://task.test/typed');
    await submit();
    assert.deepEqual(viewCalls('nav'), [
      [10, 'back'],
      [10, 'reload'],
      [10, 'load', 'https://task.test/typed'],
    ]);
  });

  test('view: Annotate receives the active native view handle', async () => {
    await viewSetup();
    await viewEvent({ type: 'did-navigate', state: viewState({ url: 'https://task.test/annotate' }) });
    await click('Annotate');
    assert.ok(container.querySelector('.annotate-stub'));
    assert.equal(container.querySelector('webview'), null);
    assert.equal(fixture.annotate.webview.current.getWebContentsId(), 10);
    assert.equal(fixture.annotate.webview.current.getURL(), 'https://task.test/annotate');
    await act(async () => fixture.annotate.onExit());
    assert.equal(container.querySelector('.annotate-stub'), null);
  });

  test("view: the surface binds once per page; later renders, layers, chats and the page's own address never bind it again", async () => {
    await viewSetup();
    await viewEvent({ type: 'did-navigate', state: viewState({ url: 'https://task.test/next', title: 'Next' }) });
    await rerender({ layer: 'back', threadId: 'other-thread' });
    await act(async () => fixture.update({ paneTabs: [{ ...fixture.state.paneTabs[0], agentTab: 'key-2' }] }));
    await rerender({ layer: 'front' });
    assert.equal(viewCalls('bind').length, 1);
    // the same view, now attached to the agent's new tab
    assert.deepEqual(fixture.calls.filter((c: any) => c[0] === 'attach').at(-1), ['attach', 'agent-chat', 10, 'key-2']);
    assert.equal(stageOf().dataset.view, '10');
  });

  test('view: shown at the stage rect while in front and uncovered; hidden for overlays, behind, and once unmounted', async () => {
    await viewSetup();
    // happy-dom lays nothing out: an empty stage is hidden
    assert.deepEqual(viewCalls('bounds'), [[10, null]]);
    placeStage({ x: 400, y: 80, width: 600, height: 700 });
    await act(async () => window.dispatchEvent(new window.Event('resize') as any));
    assert.deepEqual(viewCalls('bounds').at(-1), [10, { x: 400, y: 80, width: 600, height: 700 }]);
    // the same rect is not sent again
    await act(async () => window.dispatchEvent(new window.Event('resize') as any));
    assert.equal(viewCalls('bounds').length, 2);
    // changes within one frame measure once; a report main fails is ignored
    const raf = globalThis.requestAnimationFrame;
    const frames: Function[] = [];
    (globalThis as any).requestAnimationFrame = (fn: Function) => frames.push(fn);
    fixture.nativeHandlers['view.bounds'] = async () => {
      throw new Error('gone');
    };
    placeStage({ x: 400, y: 80, width: 640, height: 700 });
    await act(async () => {
      window.dispatchEvent(new window.Event('resize') as any);
      window.dispatchEvent(new window.Event('resize') as any);
    });
    assert.equal(frames.length, 1);
    await act(async () => frames[0]());
    (globalThis as any).requestAnimationFrame = raf;
    fixture.nativeHandlers['view.bounds'] = async () => true;
    assert.deepEqual(viewCalls('bounds').at(-1), [10, { x: 400, y: 80, width: 640, height: 700 }]);
    placeStage({ x: 400, y: 80, width: 600, height: 700 });
    await act(async () => window.dispatchEvent(new window.Event('resize') as any));
    // an app menu over the page hides it; it comes back when the menu goes
    const menu = document.createElement('div');
    menu.className = 'menu';
    (menu as any).getBoundingClientRect = () => ({ left: 500, top: 100, width: 100, height: 100 });
    await act(async () => document.body.append(menu));
    await act(async () => window.dispatchEvent(new window.Event('resize') as any));
    assert.deepEqual(viewCalls('bounds').at(-1), [10, null]);
    menu.remove();
    await act(async () => window.dispatchEvent(new window.Event('resize') as any));
    assert.deepEqual(viewCalls('bounds').at(-1), [10, { x: 400, y: 80, width: 600, height: 700 }]);
    // behind another tab: hidden, and nothing more is measured
    await rerender({ layer: 'back' });
    assert.deepEqual(viewCalls('bounds').slice(-2), [
      [10, null],
      [10, null],
    ]);
    const n = viewCalls('bounds').length;
    await act(async () => window.dispatchEvent(new window.Event('resize') as any));
    assert.equal(viewCalls('bounds').length, n);
    await rerender({ layer: 'front' });
    // a failed report is ignored (the page went); unmounting hides it
    fixture.nativeHandlers['view.bounds'] = async () => {
      throw new Error('gone');
    };
    await act(async () => root.unmount());
    clearRoot();
    assert.deepEqual(viewCalls('bounds').at(-1), [10, null]);
  });

  test('view: a menu mounted or removed over the page is noticed without any resize, and an unchanged rect sends nothing', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    await viewSetup();
    placeStage({ x: 400, y: 80, width: 600, height: 700 });
    await act(async () => t.mock.timers.tick(250));
    assert.deepEqual(viewCalls('bounds').at(-1), [10, { x: 400, y: 80, width: 600, height: 700 }], 'a stage that moved without resizing');
    const n = viewCalls('bounds').length;
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(viewCalls('bounds').length, n, 'the same rect is not sent again');
    const frame = () => act(async () => new Promise<void>((r) => setTimeout(r, 40)));
    const menu = document.createElement('div');
    menu.className = 'menu';
    (menu as any).getBoundingClientRect = () => ({ left: 500, top: 100, width: 100, height: 100 });
    await act(async () => document.body.append(menu));
    await frame();
    assert.deepEqual(viewCalls('bounds').at(-1), [10, null], 'the view hides under the menu');
    menu.remove();
    await frame();
    assert.deepEqual(viewCalls('bounds').at(-1), [10, { x: 400, y: 80, width: 600, height: 700 }], 'and comes back with it gone');
    // an overlay already there moves onto the page by a style change: watched on its own attributes
    const layer = document.createElement('div');
    layer.className = 'menu';
    let at = 0;
    (layer as any).getBoundingClientRect = () => ({ left: at, top: 100, width: 100, height: 100 });
    await act(async () => document.body.append(layer));
    await frame();
    assert.deepEqual(viewCalls('bounds').at(-1), [10, { x: 400, y: 80, width: 600, height: 700 }]);
    at = 500;
    layer.style.left = '500px';
    await frame();
    assert.deepEqual(viewCalls('bounds').at(-1), [10, null]);
    layer.remove();
    await act(async () => root.unmount());
    clearRoot();
  });

  test("view: a closed page closes the pane tab, from main's event or a bind that finds it gone", async () => {
    await viewSetup();
    await viewEvent({ id: 11, type: 'closed' });
    assert.deepEqual(
      fixture.calls.filter((c: any[]) => c[0] === 'close'),
      [],
    );
    await viewEvent({ type: 'closed' });
    assert.deepEqual(
      fixture.calls.filter((c: any[]) => c[0] === 'close'),
      [['close', 'tab']],
    );
    await act(async () => root.unmount());
    container.remove();
    await viewSetup({ handlers: { 'view.bind': async () => ({ closed: true }) } });
    assert.deepEqual(
      fixture.calls.filter((c: any[]) => c[0] === 'close'),
      [['close', 'tab']],
    );
    assert.equal(stageOf().dataset.view, undefined);
  });

  test('view: a refused, failed or late bind leaves the stage empty', async () => {
    await viewSetup({ handlers: { 'view.bind': async () => null } });
    assert.equal(stageOf().dataset.view, undefined);
    assert.deepEqual(viewCalls('bounds'), []);
    await act(async () => root.unmount());
    container.remove();
    await viewSetup({
      handlers: {
        'view.bind': async () => {
          throw new Error('refused');
        },
      },
    });
    assert.equal(stageOf().dataset.view, undefined);
    await act(async () => root.unmount());
    container.remove();
    let answer: (v: any) => void = () => {};
    await viewSetup({ handlers: { 'view.bind': () => new Promise((r) => (answer = r)) } });
    await act(async () => root.unmount());
    clearRoot();
    await act(async () => answer({ id: 10, state: viewState() }));
    assert.deepEqual(
      fixture.calls.filter((c: any[]) => c[0] === 'pageState'),
      [],
    );
  });

  test('view: a crashed page loads again in place, and a failed reload says so', async () => {
    await viewSetup();
    await notice(event('crashed'));
    await noticeClick('Reload');
    assert.deepEqual(viewCalls('nav').at(-1), [10, 'load', 'https://task.test/start']);
    assert.equal(stageOf().dataset.view, '10', 'the same view');
    fixture.nativeHandlers['view.nav'] = async () => {
      throw new Error('ERR_FAILED');
    };
    await noticeClick('Reload');
    assert.match(container.textContent!, /Couldn't reload this page/);
    // the address bar on a crashed page loads in the same view too
    fixture.nativeHandlers['view.nav'] = async () => {};
    await change('input', 'https://task.test/again');
    await submit();
    assert.deepEqual(viewCalls('nav').at(-1), [10, 'load', 'https://task.test/again']);
    // with no url the tab's source is retried
    await rerender({});
    fixture.state.paneTabs[0].url = '';
    await notice(event('crashed'));
    await noticeClick('Reload');
    assert.deepEqual(viewCalls('nav').at(-1)[1], 'load');
  });

  test('view: a reload that a newer load or Stop cut short is no failure (#3988)', async () => {
    await viewSetup();
    fixture.nativeHandlers['view.nav'] = async () => {
      throw new Error('ERR_ABORTED (-3) loading');
    };
    // a failed page's Retry
    await viewEvent({ type: 'did-fail-load', detail: { isMainFrame: true, errorCode: -105, validatedURL: 'https://missing.test/' } });
    await noticeClick('Retry');
    assert.deepEqual(viewCalls('nav').at(-1), [10, 'load', 'https://missing.test/']);
    assert.doesNotMatch(container.textContent!, /Couldn't reload this page/);
    // a crashed page's restart, at the tab's address (the one that failed)
    await notice(event('crashed'));
    await noticeClick('Reload');
    assert.equal(viewCalls('nav').length, 2);
    assert.doesNotMatch(container.textContent!, /Couldn't reload this page/);
  });

  test('view: a blank tab binds a view once it gets its first address', async () => {
    // a user's tab names the chat whose pane shows it (its stable id), so its pages ask on that chat's card
    await viewSetup({ tab: { url: '', agentChat: undefined }, chatOf: (id: string) => (id === 'thread' ? 'chat-9' : id) });
    assert.deepEqual(viewCalls('bind'), []);
    await change('input', 'https://task.test/first');
    await submit();
    assert.deepEqual(viewCalls('bind'), [
      ['tab', { chatId: null, chat: null, tabKey: null, url: 'https://task.test/first', partition: 'persist:browser' }],
    ]);
  });

  test('view: a pane of no chat binds its tab to no chat', async () => {
    await viewSetup({ tab: { agentChat: undefined }, props: { threadId: null } });
    assert.deepEqual(viewCalls('bind'), [
      ['tab', { chatId: null, chat: null, tabKey: null, url: 'https://task.test/start', partition: 'persist:browser' }],
    ]);
  });
}
