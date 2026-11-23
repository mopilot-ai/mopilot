// Browser-panel agent-controls unit cases with a shared recording fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, fixture, root, container, setup, emit, button, click, rerender } from './fixture';

export function registerAgentControlsCases() {
  test("agent bar: shows main's view of the agent on this tab, takes over, hands back and stops the chat", async () => {
    const view = (patch: any = {}) => ({
      tabId: 'tab_abc123',
      tabKey: 'tab_abc123',
      kind: 'tab',
      active: true,
      created: false,
      mark: null,
      takenOver: false,
      origin: 'https://task.test',
      access: 'write',
      ...patch,
    });
    await setup({ tab: { agentTab: 'tab_abc123' } });
    assert.equal(container.querySelector('.browser-agent-bar'), null);
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ active: false })] } }));
    assert.equal(container.querySelector('.browser-agent-bar'), null);
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view()] } }));
    assert.match(container.querySelector('.browser-agent-bar')!.textContent!, /Agent is using this tab.*Can read and act/);
    // a site the agent can't act on: its pill opens Browser settings, where its permission is changed
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ access: 'read' })] } }));
    await click('Read only');
    assert.deepEqual(fixture.calls.at(-1), ['navigate', { name: 'settings', section: 'browser' }]);
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view()] } }));
    await click('Take over');
    assert.deepEqual(fixture.calls.filter((c: any) => c[0] === 'takeOver').at(-1), ['takeOver', 'agent-chat', 'tab_abc123', true]);
    fixture.nativeHandlers.takeOver = async () => false;
    await click('Take over');
    assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't take over: the tab closed or the turn ended. Press Stop.", 'error']);
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ takenOver: true, access: null })] } }));
    assert.match(container.textContent!, /You took over this tab for this turn/);
    assert.equal(container.querySelector('.browser-agent-access'), null);
    // a Host's whole desktop is a desktop, not a tab
    await act(async () =>
      fixture.update({ agentTabs: { 'agent-chat': [view({ takenOver: true, access: null, desktop: { machine: 'box' } })] } }),
    );
    assert.match(container.textContent!, /You took over this desktop for this turn/);
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ takenOver: true, access: null })] } }));
    await click('Done, continue');
    assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't hand this tab back", 'error']);
    fixture.nativeHandlers.takeOver = async () => true;
    await click('Done, continue');
    assert.deepEqual(fixture.calls.filter((c: any) => c[0] === 'takeOver').at(-1), ['takeOver', 'agent-chat', 'tab_abc123', false]);
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ created: true })] } }));
    assert.match(container.textContent!, /Agent opened this tab/);
    await click('Stop');
    assert.deepEqual(fixture.calls.filter((c: any) => c[0] === 'stopAgent').at(-1), ['stopAgent', 'agent-chat']);
    fixture.nativeHandlers.stopAgent = async () => {
      throw new Error('gone');
    };
    await click('Stop');
    assert.deepEqual(fixture.calls.at(-1), ['toast', "Couldn't stop the agent", 'error']);
  });

  test('result bar: the tab the agent finished on says so after its turn, and gives way to the agent bar when it acts again', async () => {
    const view = (patch: any = {}) => ({
      tabId: 'tab_abc123',
      tabKey: 'tab_abc123',
      kind: 'tab',
      active: false,
      created: false,
      mark: null,
      takenOver: false,
      result: true,
      origin: 'https://task.test',
      access: 'write',
      ...patch,
    });
    await setup({ tab: { agentTab: 'tab_abc123' } });
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view()] } }));
    const bar = container.querySelector('.browser-agent-bar')!;
    assert.equal(bar.getAttribute('data-state'), 'result');
    assert.match(bar.textContent!, /Result.*The agent finished on this page/);
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ result: false })] } }));
    assert.equal(container.querySelector('.browser-agent-bar'), null);
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ active: true })] } }));
    assert.equal(container.querySelectorAll('.browser-agent-bar').length, 1);
    assert.equal(container.querySelector('.browser-agent-bar')!.getAttribute('data-state'), 'active');
  });

  test('agent bar: after a hand-off the tab is the user\'s turn, with Done, continue and Stop; "Sign in to" only for a credential page (#1834)', async () => {
    const view = (patch: any = {}) => ({
      tabId: 'tab_abc123',
      tabKey: 'tab_abc123',
      kind: 'tab',
      active: true,
      created: true,
      mark: 'handoff',
      takenOver: false,
      origin: 'https://github.com',
      access: 'write',
      signin: { reason: 'GitHub', credential: true },
      ...patch,
    });
    await setup({ tab: { agentTab: 'tab_abc123' } });
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view()] } }));
    const bar = () => container.querySelector('.browser-agent-bar');
    assert.equal(bar()!.getAttribute('data-state'), 'handoff');
    assert.equal(bar()!.querySelector('.browser-agent-text')!.textContent, 'Sign in to github.com');
    assert.doesNotMatch(container.textContent!, /Agent opened this tab|Take over/);
    await click('Done, continue');
    assert.deepEqual(fixture.calls.filter((c: any) => c[0] === 'signinDone').at(-1), ['signinDone', 'agent-chat', 'tab_abc123']);
    // nothing holds the tab any more (the user replied first): says so
    fixture.nativeHandlers.signinDone = async () => false;
    await click('Done, continue');
    assert.deepEqual(fixture.calls.at(-1), ['toast', 'Nothing is waiting on this tab any more', 'error']);
    // a form, a CAPTCHA or details only the user has: their turn, not a sign-in
    await act(async () =>
      fixture.update({ agentTabs: { 'agent-chat': [view({ signin: { reason: 'Passport number', credential: false } })] } }),
    );
    assert.equal(bar()!.querySelector('.browser-agent-text')!.textContent, 'Your turn on github.com');
    // the agent's turn has ended with the hand-off (it no longer holds the tab): the bar still shows, and a blank page names no site
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ active: false, origin: null, access: null })] } }));
    assert.equal(bar()!.querySelector('.browser-agent-text')!.textContent, 'Sign in to this page');
    // Done: the agent has the tab again
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ signin: null })] } }));
    assert.equal(bar()!.getAttribute('data-state'), 'active');
    assert.match(bar()!.textContent!, /Agent opened this tab and is using it/);
    assert.ok(button('Take over'));
    // the turn ended: the hand-off is over and the kept tab shows no bar
    await act(async () => fixture.update({ agentTabs: { 'agent-chat': [view({ signin: null, active: false })] } }));
    assert.equal(bar(), null);
  });

  test('agent bar: a tab of no agent chat, or another tab of the chat, shows no bar', async () => {
    await setup({ tab: { agentChat: undefined } });
    await act(async () =>
      fixture.update({
        agentTabs: {
          thread: [
            {
              tabId: 'tab_abc123',
              tabKey: null,
              kind: 'tab',
              active: true,
              created: false,
              mark: null,
              takenOver: false,
              origin: null,
              access: null,
            },
          ],
        },
      }),
    );
    assert.equal(container.querySelector('.browser-agent-bar'), null);
    await act(async () => root.unmount());
    container.remove();
    await setup();
    await act(async () =>
      fixture.update({
        agentTabs: {
          'agent-chat': [
            {
              tabId: 'tab_abc123',
              tabKey: 'tab_abc123',
              kind: 'tab',
              active: true,
              created: false,
              mark: null,
              takenOver: false,
              origin: null,
              access: null,
            },
          ],
        },
      }),
    );
    assert.equal(container.querySelector('.browser-agent-bar'), null);
  });

  test("layer: an agent's tab tells main how the pane lays its page out, on attach and on every change", async () => {
    await setup({ guestError: true, props: { layer: 'none' } });
    const layers = () => fixture.calls.filter((c: any) => c[0] === 'layer');
    // not attached yet: nothing to report
    await rerender({ layer: 'back' });
    assert.deepEqual(layers(), []);
    fixture.guestError = false;
    await emit('did-attach');
    assert.deepEqual(layers(), [['layer', 10, 'back']]);
    await rerender({ layer: 'front' });
    assert.deepEqual(layers().at(-1), ['layer', 10, 'front']);
    // main refusing (another window's page, a gone guest) changes nothing here
    fixture.nativeHandlers.layer = async () => {
      throw new Error('refused');
    };
    await rerender({ layer: 'none' });
    assert.deepEqual(layers().at(-1), ['layer', 10, 'none']);
  });

  test('layer: the default is in front, and a tab of no agent chat reports nothing', async () => {
    await setup();
    await emit('did-attach');
    assert.deepEqual(fixture.calls.filter((c: any) => c[0] === 'layer').at(-1), ['layer', 10, 'front']);
    await act(async () => root.unmount());
    await setup({ tab: { agentChat: undefined } });
    await emit('did-attach');
    await rerender({ layer: 'back' });
    assert.deepEqual(
      fixture.calls.filter((c: any) => c[0] === 'layer'),
      [],
    );
  });
}
