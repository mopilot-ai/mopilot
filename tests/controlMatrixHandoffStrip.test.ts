// Control-matrix cases for the hand-off strip's actions (group K): "Open tab" is offered only when it would
// change what the user sees, decided by the same store rule openAgentBrowserTab follows (edge2 twofa, E-X1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeFiles } from '../scripts/source-tree.mjs';
import { loadStore } from './support/store-harness.ts';
import { frontTab, viewChats, inView } from '../src/lib/agentTabs.ts';

export const GUARDS = ['src/'];

const { store, resetState } = await loadStore();
const ROOT = new URL('../', import.meta.url);

/** What the user sees of the pane: whether it is open and which tab is in front. */
function seen() {
  const s = store.useStore.getState();
  const chats = viewChats(s.route.name === 'thread' ? s.route.id : null, s.paneTabs);
  const front = frontTab(s.paneTabs, s.paneActive, chats, store.chatOf);
  return { open: s.diffPanel.open, front, shown: s.paneTabs.filter((t: any) => inView(t, chats, store.chatOf)).map((t: any) => t.id) };
}

const original = { id: 'browser-a', kind: 'browser', agentChat: 'chat1' };
const second = { id: 'browser-k2', kind: 'browser', agentChat: 'chat1', agentTab: 'k2' };
const other = { id: 'browser-b', kind: 'browser', agentChat: 'chat2' };
const changes = { id: 'changes', kind: 'changes' };

test('CM-K18: guard: the hand-off strip offers "Open tab" only when opening the tab changes what the user sees, by the rule openAgentBrowserTab follows', () => {
  const tabSets = [[], [original], [original, second], [changes, original, second], [changes, other], [original, other, second]];
  const actives = ['', 'changes', 'browser-a', 'browser-k2', 'browser-b', 'gone'];
  const routes = [{ name: 'thread', id: 'chat1' }, { name: 'thread', id: 'chat2' }, { name: 'home' }];
  let dead = 0;
  let live = 0;
  for (const paneTabs of tabSets)
    for (const paneActive of actives)
      for (const open of [false, true])
        for (const route of routes)
          for (const chat of ['chat1', 'chat2'])
            for (const tabKey of [undefined, null, '', 'k2', 'k9']) {
              resetState();
              store.useStore.setState({ route, paneTabs, paneActive, diffPanel: { open }, threads: {}, segments: {} } as any);
              const says = store.agentBrowserTabOpens(store.useStore.getState(), chat, { tabKey });
              const before = seen();
              store.openAgentBrowserTab(chat, { tabKey });
              const changed = JSON.stringify(seen()) !== JSON.stringify(before);
              assert.equal(says, changed, JSON.stringify({ paneTabs: paneTabs.map((t) => t.id), paneActive, open, route, chat, tabKey }));
              if (says) live++;
              else dead++;
            }
  // both outcomes are exercised: the edge2 case (the tab in front of the open pane) is a dead end
  assert.ok(dead > 0 && live > 0);
  resetState();
  store.useStore.setState({ route: routes[0], paneTabs: [original], paneActive: 'browser-a', diffPanel: { open: true } } as any);
  assert.equal(store.agentBrowserTabOpens(store.useStore.getState(), 'chat1'), false);
  // the strip offers Open tab only through that rule, and every other in-app tab opener in a component is gated the same way
  const strip = fs.readFileSync(new URL('src/components/thread/HandoffStrip.tsx', ROOT), 'utf8');
  assert.match(
    strip,
    /if \(agentBrowserTabOpens\(\{ paneTabs, paneActive, diffPanel, route, split \}, key, \{ tabKey: tab\?\.tabKey \}\)\)\n\s+open = \(\) => openAgentBrowserTab\(/,
  );
  const dir = fileURLToPath(new URL('src/components/', ROOT));
  for (const file of treeFiles(dir, /\.tsx?$/)) {
    const f = path.relative(dir, file);
    const src = fs.readFileSync(file, 'utf8');
    const opens = src.match(/\bopenAgentBrowserTab\(/g)?.length ?? 0;
    const gated = src.match(/\bagentBrowserTabOpens\(/g)?.length ?? 0;
    assert.ok(opens <= gated, `${f}: every button that opens an agent tab asks agentBrowserTabOpens first`);
  }
});
