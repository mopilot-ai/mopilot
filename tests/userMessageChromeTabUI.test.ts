// A message sent from Chrome's side panel, as the thread draws it: the tab line the panel adds for the agent
// ("[Chrome tab: <address>]") is not the user's words, so the bubble shows what they typed and the tab as a chip by its
// site, the whole address on hover, opened on click.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, setStore, impl, resetStore, native } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/ui/Popover.tsx', 'popover', { Tooltip: ({ children }: any) => children });
autoMock('src/components/thread/PeerMessages.tsx', 'peer', { PeerContext: (await import('react')).createContext([]) });
autoMock('src/session/harness/claude.ts', 'claude', { useCommandProvider: () => null });
autoMock('src/session/open.ts', 'open', { openMessageLink: (...a: any[]) => impl['open:openMessageLink']?.(...a) });
const { UserMessage } = await import('../src/components/thread/view/UserMessage.tsx');

let opened: any[] = [];
beforeEach(() => {
  resetStore();
  setStore({ threads: { c1: { id: 'c1', cwd: '/repo' } } });
  opened = [];
  impl['open:openMessageLink'] = (...a: any[]) => opened.push(a[0]);
});

const message = (text: string) =>
  h(UserMessage, {
    threadId: 'c1',
    turnId: 't1',
    userIndex: 0,
    canEdit: false,
    item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text }] },
  } as any);

test('the side panel’s tab line is a chip by its site, not text in the bubble', async () => {
  const url = 'https://www.google.com/maps/place/Shangri-La+Far+Eastern,+Taipei/@25.02,121.54,17z/data=!3m1!5s0x3442';
  let v = await render(message(`这个FHR能订吗?\n\n[Chrome tab: ${url}]`));
  assert.equal(v.$('.user-bubble')?.textContent, '这个FHR能订吗?');
  const chip = v.$('.mention-chip.tab') as HTMLAnchorElement;
  assert.equal(chip.textContent, 'www.google.com');
  assert.equal(chip.title, url);
  assert.ok(chip.querySelector('svg'), 'the globe');
  chip.click();
  assert.deepEqual(opened, [url]);
  await v.unmount();
  // an address that doesn't parse (not one the panel writes) shows as it is
  v = await render(message('hi\n\n[Chrome tab: https://[]'));
  assert.equal(v.$('.mention-chip.tab')?.textContent, 'https://[');
  await v.unmount();
  // a message with no tab line has no chip
  v = await render(message('just text'));
  assert.equal(v.$('.mention-chip.tab'), null);
  await v.unmount();
});

test('audio task history renders the stored recording as a replayable audio control', async () => {
  native.speech.read = async () => 'data:audio/wav;base64,AA';
  const v = await render(
    h(UserMessage, {
      threadId: 'c1',
      turnId: 'turn',
      userIndex: 0,
      canEdit: false,
      item: { type: 'userMessage', id: 'audio', content: [{ type: 'localAudio', path: '/saved.wav' }] },
    } as any),
  );
  assert.equal(v.$('audio')?.getAttribute('src'), 'data:audio/wav;base64,AA');
  await v.unmount();
});
