// The cells of #4842 that a device check cannot all reach, as unit tests: the zh-Hans words of the routine and marked cards, an ordinary chat's row, the Home row and the notification body never carry a model-framed line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { act, createElement, createRoot } from './support/phone/component-kit';
import { apnsBody, fcmMessage } from '../relay/src/pushPayload.mjs';

const require = createRequire(import.meta.url);
const { reportText } = require('../electron/momo/routineReport.cjs');
const { GREETING } = require('../electron/momo/starterRoutines.cjs');
const bubblePath = '../mobile/src/components/MessageBubble';
const i18nPath = '../mobile/src/ui/i18n';
const chatRowPath = '../mobile/src/components/ChatRow';
const { MessageBubble } = await import(bubblePath);
const { showLocale } = await import(i18nPath);
const { ChatRow } = await import(chatRowPath);

const LEAK = /not from the user|data, not instructions|Tell the user in a line|Greet them/;

async function render(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('Simplified Chinese: the routine card says it finished or did not, the marked card is a MoPilot message', async () => {
  await showLocale('zh-Hans');
  try {
    const cases: [string, RegExp][] = [
      [reportText('收件箱', true, '两封待回。'), /“收件箱”已完成/],
      [reportText('周回顾', false, '中途停了。'), /“周回顾”未完成/],
      [GREETING, /MoPilot 消息/],
    ];
    for (const [text, words] of cases) {
      const v = await render(createElement(MessageBubble, { role: 'user', text }));
      assert.match(v.host.textContent ?? '', words);
      assert.doesNotMatch(v.host.textContent ?? '', LEAK);
      await v.done();
    }
  } finally {
    await showLocale('en');
  }
});

test('an ordinary chat’s user row (MessageBubble, as CachedRows and TranscriptBlocks draw it) is the card too', async () => {
  const v = await render(createElement(MessageBubble, { role: 'liveUser', text: reportText('Inbox sweep', true, 'Done.') }));
  assert.match(v.host.textContent ?? '', /“Inbox sweep” finished/);
  assert.doesNotMatch(v.host.textContent ?? '', LEAK);
  await v.done();
  for (const f of ['mobile/src/components/CachedRows.tsx', 'mobile/src/components/TranscriptBlocks.tsx']) {
    assert.match(fs.readFileSync(f, 'utf8'), /MessageBubble|SentBubble/, f);
  }
});

test('the Home row draws only the chat’s title and one status line, never a transcript row', async () => {
  const v = await render(createElement(ChatRow, { chat: { id: 'c', title: 'Inbox sweep', state: 'idle' }, open: () => {} }));
  assert.match(v.host.textContent ?? '', /Inbox sweep/);
  await v.done();
  assert.doesNotMatch(fs.readFileSync('mobile/src/components/ChatRow.tsx', 'utf8'), /\.text\b|preview|lastMessage/);
});

test('the notification body is empty for every kind, so a marked line can never reach it', () => {
  for (const kind of ['done', 'needsYou', 'momo', 'machineOffline', 'cleared']) {
    const m = { platform: 'apns', kind, title: 'Fixed title', ref: 'r', collapseId: 'c', token: 't', count: 1 } as any;
    assert.equal((apnsBody(m) as any).aps.alert.body, '');
    assert.doesNotMatch(JSON.stringify(fcmMessage(m)), LEAK);
  }
});
