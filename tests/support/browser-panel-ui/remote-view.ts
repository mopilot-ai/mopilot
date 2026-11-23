// Browser-panel cases for an agent's tab on another machine: the pane draws its frames, tells main how it is shown, and sends the user's input only after they took the tab over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, fixture, root, container, setup, clearRoot, window, click as clickToolbar } from './fixture';

export function registerRemoteViewCases() {
  const KEY = JSON.stringify(['host', 'box', 'tab_1']);
  const view = (patch: any = {}) => ({
    tabId: 'tab_1',
    tabKey: KEY,
    hostId: 'box',
    kind: 'tab',
    active: true,
    created: false,
    mark: null,
    takenOver: false,
    origin: 'https://shop.test',
    access: 'write',
    ...patch,
  });
  const calls = (name: string) => fixture.calls.filter((c: any[]) => c[0] === `remote.${name}`).map((c: any[]) => c.slice(1));
  const frame = (patch: any = {}) => ({
    paneId: 'tab',
    data: 'AAAA',
    mime: 'image/jpeg',
    width: 800,
    height: 600,
    url: 'https://shop.test/cart',
    title: 'Cart',
    loading: false,
    ...patch,
  });
  const push = (f: any) => act(async () => fixture.callbacks.get('remoteFrame')?.(f));
  const stage = () => container.querySelector<HTMLElement>('.remote-view')!;
  const picture = () => container.querySelector<HTMLImageElement>('.remote-view-frame')!;
  const note = () => container.querySelector('.remote-view-note')?.textContent ?? null;
  async function remoteSetup(takenOver = false) {
    await setup({ tab: { agentTab: KEY } });
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ takenOver })] } }));
    await act(async () => {});
  }
  const fire = (el: Element, type: string, init: Record<string, any> = {}) => {
    const e = Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), init);
    return act(async () => void el.dispatchEvent(e as unknown as Event));
  };

  test('remote view: an agent tab on another machine is followed by its frames, not bound to a view of this app', async () => {
    await remoteSetup();
    assert.equal(container.querySelector('webview'), null);
    assert.deepEqual(calls('watch'), [['tab', 'agent-chat', KEY]]);
    assert.equal(fixture.calls.filter((c: any[]) => c[0] === 'view.bind').length, 0);
    assert.equal(note(), 'Opening the page on the other machine…');
    assert.equal(picture(), null);
    // the pane is front, the user has not taken over
    assert.deepEqual(calls('view').at(-1), ['tab', { visible: true, takeover: false }]);
    await push(frame({ paneId: 'someone-else' }));
    assert.equal(picture(), null, "another pane's frame is not this one's");
    await push(frame());
    assert.equal(picture().src, 'data:image/jpeg;base64,AAAA');
    assert.equal(picture().alt, 'Cart');
    assert.equal(note(), null);
    assert.equal(fixture.state.paneTabs[0].url, 'https://shop.test/cart', 'the address follows the page');
    // a failed fetch keeps the picture and says why; the next frame clears it
    await push({ paneId: 'tab', error: 'The page did not answer.' });
    assert.equal(note(), 'The page did not answer.');
    assert.ok(picture());
    await push(frame({ title: '' }));
    assert.equal(note(), null);
    assert.equal(picture().alt, 'The page on the other machine');
    // no input is sent while the agent has the tab
    await fire(stage(), 'pointerdown', { button: 0, detail: 1, clientX: 10, clientY: 10, buttons: 1 });
    await fire(stage(), 'keydown', { key: 'a', code: 'KeyA', keyCode: 65 });
    await fire(stage(), 'keyup', { key: 'a', code: 'KeyA', keyCode: 65 });
    assert.equal(calls('input').length, 0);
  });

  test('remote view: Annotate receives the remote page handle', async () => {
    await remoteSetup();
    await push(frame({ url: 'https://shop.test/annotate' }));
    await clickToolbar('Annotate');
    assert.ok(container.querySelector('.annotate-stub'));
    assert.equal(container.querySelector('webview'), null);
    assert.equal(fixture.annotate.webview.current.getURL(), 'https://shop.test/annotate');
    await act(async () => fixture.annotate.onExit());
    assert.equal(container.querySelector('.annotate-stub'), null);
  });

  test('remote view: taking the tab over tells main (faster frames) and sends clicks, drags, wheel, keys and paste to the page', async () => {
    await remoteSetup();
    await push(frame());
    picture().getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 300 }) as DOMRect;
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ takenOver: true })] } }));
    assert.deepEqual(calls('view').at(-1), ['tab', { visible: true, takeover: true }]);
    assert.equal(stage().tabIndex, 0);
    const input = () => calls('input').map((c: any[]) => c[1]);
    await fire(stage(), 'pointerdown', { button: 0, detail: 1, clientX: 300, clientY: 200, buttons: 1 });
    assert.deepEqual(input()[0], { kind: 'mouse', type: 'down', x: 400, y: 300, button: 'left', clickCount: 1, modifiers: 0 });
    // a move without a button is not sent; a drag is
    await fire(stage(), 'pointermove', { button: 0, detail: 0, clientX: 310, clientY: 210, buttons: 0 });
    await fire(stage(), 'pointermove', { button: 0, detail: 0, clientX: 320, clientY: 220, buttons: 1 });
    await fire(stage(), 'pointerup', { button: 0, detail: 1, clientX: 320, clientY: 220, buttons: 0 });
    assert.deepEqual(
      input().map((i: any) => i.type),
      ['down', 'move', 'up'],
    );
    // a button the page has no use for, and a point off the frame's size, send nothing
    await fire(stage(), 'pointerdown', { button: 4, detail: 1, clientX: 300, clientY: 200, buttons: 1 });
    assert.equal(input().length, 3);
    await fire(stage(), 'wheel', { clientX: 300, clientY: 200, deltaX: 0, deltaY: 120 });
    assert.deepEqual(input()[3], { kind: 'mouse', type: 'wheel', x: 400, y: 300, deltaX: 0, deltaY: 120 });
    await fire(stage(), 'keydown', { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    await fire(stage(), 'keyup', { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    assert.deepEqual(input().slice(4), [
      { kind: 'key', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a' },
      { kind: 'key', type: 'up', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a' },
    ]);
    await fire(stage(), 'paste', { clipboardData: { getData: () => 'secret' } });
    assert.deepEqual(input().at(-1), { kind: 'text', text: 'secret' });
    await fire(stage(), 'paste', { clipboardData: { getData: () => '' } });
    assert.equal(input().length, 7, 'nothing to paste');
    // the context menu is the page's, not the pane's
    const menu = new window.Event('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => void stage().dispatchEvent(menu as unknown as Event));
    assert.equal(menu.defaultPrevented, true);
    // handed back: input stops again
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ takenOver: false })] } }));
    assert.equal(stage().tabIndex, -1);
    await fire(stage(), 'pointerdown', { button: 0, detail: 1, clientX: 300, clientY: 200, buttons: 1 });
    await fire(stage(), 'paste', { clipboardData: { getData: () => 'x' } });
    const handedBack = new window.Event('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => void stage().dispatchEvent(handedBack as unknown as Event));
    assert.equal(handedBack.defaultPrevented, false);
    assert.equal(input().length, 7);
  });

  test('remote view: input before the first frame has nowhere to land; a failed call to main is noted, not thrown; closing the tab stops following', async () => {
    await remoteSetup(true);
    await fire(stage(), 'pointerdown', { button: 0, detail: 1, clientX: 5, clientY: 5, buttons: 1 });
    assert.equal(calls('input').length, 0, 'no frame yet');
    await push(frame());
    picture().getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
    fixture.nativeHandlers['remote.input'] = async () => {
      throw new Error('main said no');
    };
    await fire(stage(), 'pointerdown', { button: 0, detail: 1, clientX: 5, clientY: 5, buttons: 1 });
    assert.equal(calls('input').length, 1);
    await act(async () => root.unmount());
    clearRoot();
    assert.deepEqual(calls('stop'), [['tab']]);
    assert.equal(fixture.callbacks.has('remoteFrame'), false);
  });

  test('remote view: a tab that cannot be followed or shown leaves the stage empty and says nothing more', async () => {
    await setup({
      tab: { agentTab: KEY },
      handlers: {
        'remote.watch': async () => {
          throw new Error('refused');
        },
        'remote.view': async () => {
          throw new Error('refused');
        },
        'remote.stop': async () => {
          throw new Error('refused');
        },
      },
    });
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view()] } }));
    assert.equal(note(), 'Opening the page on the other machine…');
    await act(async () => root.unmount());
    clearRoot();
  });

  const bar = () => container.querySelector<HTMLElement>('.remote-view-bar');
  const action = () => container.querySelector<HTMLButtonElement>('.remote-view-bar-action')!;
  const click = () => act(async () => void action().click());

  test("remote view: a dev server on the machine's loopback is offered to this Mac, and opens as a pane tab at the forwarded address", async () => {
    await remoteSetup();
    await push(frame());
    assert.equal(bar(), null, 'a page elsewhere has no bar');
    await push(frame({ url: 'http://localhost:5173/app?x=1' }));
    assert.match(bar()!.textContent ?? '', /port 5173/);
    let finish: (v: { localPort: number }) => void = () => undefined;
    fixture.nativeHandlers['host.forwardPort'] = () => new Promise((resolve) => (finish = resolve));
    await click();
    assert.deepEqual(calls('forwardPort'), [], 'asked through the host bridge, not the remote one');
    assert.deepEqual(
      fixture.calls.filter((c: any[]) => c[0] === 'host.forwardPort'),
      [['host.forwardPort', 'box', 5173]],
    );
    assert.equal(action().disabled, true, 'one ask at a time');
    assert.equal(action().textContent, 'Opening…');
    await act(async () => finish({ localPort: 41000 }));
    assert.deepEqual(fixture.calls.filter((c: any[]) => c[0] === 'open').at(-1), [
      'open',
      'browser',
      { url: 'http://127.0.0.1:41000/app?x=1' },
    ]);
    assert.equal(action().disabled, false);
    // the page moved off the loopback: the bar goes
    await push(frame({ url: 'https://shop.test/' }));
    assert.equal(bar(), null);
  });

  test("B: a forward that failed says so in the bar and can be tried again; the bar's own clicks and keys never reach the page during a takeover", async () => {
    await remoteSetup(true);
    await push(frame({ url: 'http://127.0.0.1:3000/' }));
    picture().getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
    fixture.nativeHandlers['host.forwardPort'] = async () => {
      throw new Error('The machine did not answer in time.');
    };
    await fire(action(), 'pointerdown', { button: 0, detail: 1, clientX: 5, clientY: 5, buttons: 1 });
    await fire(action(), 'pointermove', { button: 0, detail: 0, clientX: 5, clientY: 5, buttons: 1 });
    await fire(action(), 'pointerup', { button: 0, detail: 1, clientX: 5, clientY: 5, buttons: 0 });
    await fire(action(), 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 });
    await fire(action(), 'keyup', { key: 'Enter', code: 'Enter', keyCode: 13 });
    await fire(action(), 'wheel', { clientX: 5, clientY: 5, deltaX: 0, deltaY: 40 });
    assert.equal(calls('input').length, 0, 'the page heard none of it');
    await click();
    assert.match(bar()!.textContent ?? '', /did not answer/);
    assert.equal(action().disabled, false, 'it can be tried again');
    fixture.nativeHandlers['host.forwardPort'] = async () => ({ localPort: 41002 });
    await click();
    assert.match(bar()!.textContent ?? '', /port 3000/, 'the failure is cleared by the next try');
    assert.deepEqual(fixture.calls.filter((c: any[]) => c[0] === 'open').at(-1), ['open', 'browser', { url: 'http://127.0.0.1:41002/' }]);
  });
}
