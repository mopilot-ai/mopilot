// Browser-panel toolbar unit cases with a shared recording fixture.
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
  emit,
  notice,
  button,
  click,
  change,
  submit,
  clearRoot,
  input,
  tabState,
  noticeClick,
} from './fixture';

export function registerToolbarCases() {
  test('a loaded tab follows the page: navigation state, address, title and toolbar actions', async () => {
    await setup({ tab: { agentChat: undefined } });
    fixture.state = { ...fixture.state, paneTabs: [...fixture.state.paneTabs, { id: 'other', kind: 'files' }] };
    const wv = fixture.guest;
    assert.equal(wv.getAttribute('partition'), 'persist:browser');
    assert.equal((button('Back') as HTMLButtonElement).disabled, true);
    fixture.guestUrl = 'https://example.com/b';
    fixture.title = 'B page';
    fixture.back = true;
    fixture.forward = true;
    await emit('did-navigate');
    assert.equal((button('Back') as HTMLButtonElement).disabled, false);
    assert.equal((button('Forward') as HTMLButtonElement).disabled, false);
    assert.equal(input().value, 'example.com', 'only the host shows while unfocused');
    // as the Codex app shows it: no "www.", and a local server with its path and query, which tell its pages apart
    for (const [url, shown] of [
      ['https://www.example.com/x', 'example.com'],
      ['http://localhost:5173/', 'localhost:5173'],
      ['http://127.0.0.1:8765/report?id=2', '127.0.0.1:8765/report?id=2'],
      ['http://app.localhost/a', 'app.localhost/a'],
      ['https://example.com/b', 'example.com'],
    ]) {
      fixture.guestUrl = url;
      await emit('did-navigate');
      assert.equal(input().value, shown, url);
    }
    assert.equal(tabState().url, 'https://example.com/b');
    assert.equal(tabState().title, 'B page');
    assert.deepEqual(tabState('other'), { id: 'other', kind: 'files' });
    fixture.title = '';
    fixture.guestUrl = 'https://example.com/c';
    await emit('page-title-updated');
    assert.equal(tabState().title, 'https://example.com/c', 'an untitled page is named by its url');
    await click('Open in default browser');
    assert.deepEqual(fixture.calls.at(-1), ['external', 'https://example.com/c']);
    await act(async () => root.unmount());
    clearRoot();
    const before = fixture.calls.length;
    fixture.loading = true;
    await emit('did-start-loading');
    await emit('did-navigate');
    assert.equal(fixture.calls.length, before, 'listeners are removed on unmount');
    assert.equal(tabState().url, 'https://example.com/c');
  });

  test('the address bar loads urls, local hosts and searches in the page', async () => {
    await setup({ tab: { agentChat: undefined }, props: { threadId: null } });
    for (const text of ['  ', 'localhost:5173/app', 'docs.rs/serde', 'how to test']) {
      await change('.browser-addr input', text);
      await submit();
    }
    assert.deepEqual(
      fixture.calls.filter((c: any) => c[0] === 'loadURL'),
      [
        ['loadURL', 'http://localhost:5173/app'],
        ['loadURL', 'https://docs.rs/serde'],
        ['loadURL', 'https://www.google.com/search?q=how%20to%20test'],
      ],
    );
    assert.equal(tabState().url, 'https://www.google.com/search?q=how%20to%20test');
    // the tab keeps the title it had until the new page names itself
    await act(async () => fixture.update({ paneTabs: fixture.state.paneTabs.map((t: any) => ({ ...t, title: 'Serde docs' })) }));
    await change('.browser-addr input', 'docs.rs/tokio');
    await submit();
    assert.equal(tabState().title, 'Serde docs');
    assert.equal(tabState().url, 'https://docs.rs/tokio');
    // a tab with no title yet is named by the address it opens
    await act(async () => fixture.update({ paneTabs: fixture.state.paneTabs.map((t: any) => ({ ...t, title: '' })) }));
    await change('.browser-addr input', 'docs.rs/rand');
    await submit();
    assert.equal(tabState().title, 'https://docs.rs/rand');
  });

  test('focusing the address shows the full url and selects it; the full-url pref keeps it shown', async () => {
    await setup({ tab: { url: 'https://example.com/path?q=1', agentChat: undefined }, props: { threadId: null } });
    assert.equal(input().value, 'example.com');
    let selected = 0;
    input().select = () => {
      selected++;
    };
    await act(async () => {
      input().dispatchEvent(new (window as any).FocusEvent('focusin', { bubbles: true }));
    });
    assert.equal(input().value, 'https://example.com/path?q=1');
    assert.equal(selected, 1);
    await act(async () => {
      input().dispatchEvent(new (window as any).FocusEvent('focusout', { bubbles: true }));
    });
    assert.equal(input().value, 'example.com');
    await act(async () => fixture.update({ prefs: { browserFullUrl: true } }));
    assert.equal(input().value, 'https://example.com/path?q=1');
    await act(async () => fixture.update({ prefs: { browserFullUrl: false } }));
    await change('.browser-addr input', 'not a url');
    assert.equal(input().value, 'not a url', 'text that is not a url shows as typed');
  });

  test('an agent tab hands its guest to main once the page is ready', async () => {
    await setup({ guestError: true, tab: { agentChat: 'chat-1' } });
    assert.deepEqual(
      fixture.calls.filter((c: any) => c[0] === 'attach'),
      [],
    );
    fixture.guestError = false;
    await emit('dom-ready');
    assert.deepEqual(
      fixture.calls.filter((c: any) => c[0] === 'attach'),
      [['attach', 'chat-1', 10, undefined]],
    );
  });

  test('a blank tab focuses the address, offers the tools and opens a typed url', async () => {
    await setup({ tab: { url: undefined, agentChat: undefined }, props: { cwd: '/work/app', threadId: 't1' } });
    assert.equal(document.activeElement, input());
    assert.equal((button('Reload') as HTMLButtonElement).disabled, true);
    assert.equal((button('Open in default browser') as HTMLButtonElement).disabled, true);
    const tools = [...container.querySelectorAll('.newtab-tool')] as HTMLButtonElement[];
    assert.deepEqual(
      tools.map((t) => t.querySelector('span')!.textContent),
      ['Changes', 'Terminal', 'Files', 'Side chat'],
    );
    assert.ok(tools.every((t) => t.querySelector('kbd')!.textContent));
    for (const t of tools) await act(async () => t.click());
    assert.deepEqual(
      fixture.calls.filter((c: any) => ['close', 'changes', 'open', 'side'].includes(c[0])),
      [
        ['close', 'tab'],
        ['changes'],
        ['close', 'tab'],
        ['open', 'terminal', { cwd: '/work/app', title: 'app' }],
        ['close', 'tab'],
        ['open', 'files'],
        ['side', 't1', undefined, 'tab'],
      ],
    );
    await change('.browser-addr input', 'example.org');
    await submit();
    assert.equal(tabState().url, 'https://example.org/');
    assert.equal(fixture.guest.getAttribute('src'), 'https://example.org/');
    assert.deepEqual(
      fixture.calls.filter((c: any) => c[0] === 'loadURL'),
      [],
      'a blank tab has no page to load into yet',
    );
  });

  test('side chat needs a chat, and a tab missing from the store renders blank', async () => {
    await setup({ props: { tabId: 'gone', threadId: null } });
    assert.equal((button('Side chat') as HTMLButtonElement).disabled, true);
    assert.equal(input().value, '');
  });

  test('Annotate toggles the bar for the current page; exit, the toggle and a recreated page all leave it', async () => {
    await setup({ tab: { agentChat: undefined } });
    const toggle = button('Annotate');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(container.querySelector('.annotate-stub'), null);
    await click('Annotate');
    assert.ok(container.querySelector('.annotate-stub'));
    assert.equal(button('Annotate').getAttribute('aria-pressed'), 'true');
    assert.equal(fixture.annotate.threadId, 'thread');
    assert.equal(fixture.annotate.webview.current, fixture.guest);
    await act(async () => fixture.annotate.onExit());
    assert.equal(container.querySelector('.annotate-stub'), null);
    await click('Annotate');
    await click('Annotate');
    assert.equal(container.querySelector('.annotate-stub'), null);
    // crash recovery recreates the page: the old page's annotate mode ends with it
    await click('Annotate');
    await notice(event('crashed'));
    await noticeClick('Reload');
    assert.equal(container.querySelector('.annotate-stub'), null);
    assert.equal(button('Annotate').getAttribute('aria-pressed'), 'false');
  });

  test('IAB-14: Annotate floats over the page stage; the pane rows and the <webview> stay exactly as they were', async () => {
    await setup({ tab: { agentChat: undefined } });
    const pane = container.querySelector('.browser-pane')!;
    const rows = () => [...pane.children].map((el) => el.className);
    const view = container.querySelector('webview')!;
    const stage = view.parentElement!;
    const attrs = () =>
      [...view.attributes]
        .map((a) => `${a.name}=${a.value}`)
        .sort()
        .join(' ');
    const layout = { rows: rows(), attrs: attrs() };
    assert.equal(stage.className, 'browser-stage');
    assert.equal(stage.parentElement, pane);
    assert.deepEqual([...stage.children], [view]);
    await click('Annotate');
    const bar = container.querySelector('.annotate-stub')!;
    assert.equal(bar.parentElement, stage, 'the bar is in the stage, over the page');
    assert.deepEqual([...stage.children], [bar, view], 'before the page, so it comes first in focus order');
    assert.deepEqual(rows(), layout.rows, 'no new row in the pane');
    assert.equal(container.querySelector('webview'), view, 'the same page, not recreated');
    assert.equal(view.parentElement, stage);
    assert.equal(attrs(), layout.attrs);
    await click('Annotate');
    assert.equal(container.querySelector('.annotate-stub'), null);
    assert.deepEqual(rows(), layout.rows);
    assert.equal(container.querySelector('webview'), view);
    assert.deepEqual([...stage.children], [view]);
    assert.equal(attrs(), layout.attrs);
  });

  test('Annotate is unavailable on a blank tab', async () => {
    await setup({ tab: { url: '', agentChat: undefined } });
    assert.equal(container.querySelector('[aria-label="Annotate"]')?.hasAttribute('disabled'), true);
  });

  test('device: the toolbar shows the device an agent emulates in this tab, by preset or size, and nothing without one', async () => {
    const view = (device: any) => ({
      tabId: 'tab_abc123',
      tabKey: 'tab_abc123',
      kind: 'tab',
      active: true,
      created: false,
      mark: null,
      takenOver: false,
      origin: null,
      access: null,
      device,
    });
    await setup({ tab: { agentTab: 'tab_abc123' } });
    assert.equal(container.querySelector('.browser-device'), null);
    await act(async () =>
      fixture.update({ agentTabs: { 'agent-chat': [view({ preset: 'mobile', label: 'Mobile', width: 375, height: 812 })] } }),
    );
    const badge = container.querySelector('.browser-device')!;
    assert.equal(badge.textContent, 'Mobile');
    assert.equal(badge.getAttribute('title'), 'The agent is emulating a mobile device in this tab (375×812)');
    await act(async () =>
      fixture.update({ agentTabs: { 'agent-chat': [view({ preset: null, label: '1280×720', width: 1280, height: 720 })] } }),
    );
    assert.equal(container.querySelector('.browser-device')!.textContent, '1280×720');
    assert.match(container.querySelector('.browser-device')!.getAttribute('title')!, /emulating a viewport size/);
    // desktop again (or the turn ended): the badge goes
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view(null)] } }));
    assert.equal(container.querySelector('.browser-device'), null);
  });

  test("the Downloads button gets the pane's pages (its tab and that tab's popups) and whether the tab is in front", async () => {
    await setup({ tab: { agentChat: undefined } });
    assert.ok(container.querySelector('.downloads-stub'));
    assert.equal(fixture.downloads.front, true);
    await emit('dom-ready');
    await act(async () => fixture.callbacks.get('event')!(event('ready', 33)));
    assert.deepEqual(fixture.downloads.pages(), [10, 33]);
  });
}
