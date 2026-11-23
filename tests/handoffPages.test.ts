// electron/capabilities/browser/handoffPages.cjs (#1403): the sites handed to the user's Chrome for a sign-in, per chat,
// matched by origin, and electron/harness/claude/chromeTabs.cjs holdsPages leaving those pages out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { noteHandoff, handedOff, forgetHandoffs } = require('../electron/capabilities/browser/handoffPages.cjs');
const { ChromeTabs } = require('../electron/harness/claude/chromeTabs.cjs');

test('a hand-off is matched by its site for its chat only; anything that is not a web URL matches nothing', () => {
  noteHandoff('c1', 'https://shop.test/login?next=%2F');
  assert.equal(handedOff('c1', 'https://shop.test/account'), true, 'a sign-in moves within its site');
  assert.equal(handedOff('c1', 'http://shop.test/'), false, 'another origin');
  assert.equal(handedOff('c2', 'https://shop.test/'), false, 'another chat');
  assert.equal(handedOff(undefined, 'https://shop.test/'), false, 'a process with no chat yet');
  assert.equal(handedOff('c1', 'not a url'), false);
  assert.equal(handedOff('c1', 'chrome://newtab/'), false);
  // the sign-in passes through an identity provider: excused while the chat has a hand-off, never for another chat
  assert.equal(handedOff('c1', 'https://accounts.google.com/signin/v2'), true);
  assert.equal(handedOff('c2', 'https://accounts.google.com/signin/v2'), false);
  noteHandoff('', 'https://shop.test/');
  noteHandoff('c3', 'file:///etc/passwd');
  assert.equal(handedOff('c3', 'file:///etc/passwd'), false, 'only web sites are handed off');
  forgetHandoffs('c1');
  assert.equal(handedOff('c1', 'https://shop.test/account'), false);
});

test('a chat keeps its last 20 hand-off sites, and handing a site off again makes it the newest', () => {
  for (let i = 0; i < 20; i++) noteHandoff('many', `https://s${i}.test/`);
  noteHandoff('many', 'https://s0.test/again');
  noteHandoff('many', 'https://s20.test/');
  assert.equal(handedOff('many', 'https://s0.test/'), true, 'handed off again: kept');
  assert.equal(handedOff('many', 'https://s1.test/'), false, 'the oldest went');
  assert.equal(handedOff('many', 'https://s20.test/'), true);
  forgetHandoffs('many');
});

test("a Claude in Chrome group holding only handed-off or blank pages holds nothing; a page of the chat's own does", () => {
  const result = (urls: string[]) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'mcp__claude-in-chrome__navigate' }] } },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't',
            content: `Available tabs:\n${urls.map((u, i) => `  • tabId ${i}: "T" ("${u}")`).join('\n')}`,
          },
        ],
      },
    },
  ];
  noteHandoff('tabs-chat', 'https://shop.test/login');
  const t = new ChromeTabs({ chatOf: () => 'tabs-chat', handedOff });
  for (const m of result(['https://shop.test/account', 'chrome://newtab/'])) t.note(m);
  assert.equal(t.holdsPages(), false);
  for (const m of result(['https://shop.test/account', 'https://docs.test/'])) t.note(m);
  assert.equal(t.holdsPages(), true);
  // a session whose chat handed nothing off (or that has no chat yet) counts every page, as before
  const plain = new ChromeTabs({ handedOff });
  for (const m of result(['https://shop.test/account'])) plain.note(m);
  assert.equal(plain.holdsPages(), true);
  // a process with no browser layer (the Host) passes no check: nothing counts as handed off
  const bare = new ChromeTabs({ chatOf: () => 'tabs-chat' });
  for (const m of result(['https://shop.test/account'])) bare.note(m);
  assert.equal(bare.holdsPages(), true);
  assert.equal(new ChromeTabs().holdsPages(), false);
  forgetHandoffs('tabs-chat');
});
