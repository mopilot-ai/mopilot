// How main wires the tabs of every Host (electron/app/hostTabsWiring.cjs, package 3.4): the ownership record and the RemoteTabs factory are optional late-bound services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHostTabs } = require('../electron/app/hostTabsWiring.cjs');

test('until a Host has the services every chat is on this Mac and no Host has a browser', () => {
  const local: any = { o: {} };
  const tabs = createHostTabs({ live: {}, local });
  assert.equal(tabs.ownerOf('c'), 'local');
  assert.equal(tabs.make('h1'), undefined);
});

test('the chat’s Host is the ownership record’s, and a Host’s tabs redraw the pane through this Mac’s onChange', () => {
  const heard: string[] = [];
  const local: any = { o: { onChange: (c: string) => heard.push(c) } };
  const made: any[] = [];
  const live = {
    hostOwnership: { get: (c: string) => ({ hostId: c === 'moved' ? 'h2' : 'local' }) },
    remoteBrowserTabs: (hostId: string, o: any) => (made.push([hostId, o]), { remote: hostId }),
  };
  const tabs = createHostTabs({ live, local });
  assert.equal(tabs.ownerOf('moved'), 'h2');
  assert.equal(tabs.ownerOf('here'), 'local');
  assert.deepEqual(tabs.make('h2'), { remote: 'h2' });
  made[0][1].onChange('c');
  assert.deepEqual(heard, ['c']);
  // a pane without an onChange has nothing to redraw
  const quiet: any = { o: {} };
  createHostTabs({ live, local: quiet }).make('h3');
  made[1][1].onChange('c');
  assert.deepEqual(heard, ['c']);
});
