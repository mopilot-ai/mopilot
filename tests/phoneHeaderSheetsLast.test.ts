// The chat header's sheets (Permissions, Rename, Move to another computer) are drawn after the page body: drawn before it they sat under the transcript and composer on the iPhone, with the scrim over the header only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';

const headerPath = '../mobile/src/components/ChatHeader';
const { useChatHeader } = await import(headerPath);

const OPTIONS = {
  models: [],
  accounts: [],
  permissions: [{ id: 'default', label: 'Default permissions', detail: 'Ask before running commands' }],
  permission: 'default',
  permissionLabel: 'Default permissions',
  macOnly: [],
};

function Page(props: any) {
  const header = useChatHeader(props);
  return createElement('div', null, [
    createElement('div', { key: 'bar', 'data-part': 'bar' }, header.bar),
    createElement('main', { key: 'body' }, 'the transcript'),
    createElement('div', { key: 'sheets', 'data-part': 'sheets' }, header.sheets),
  ]);
}

test('the bar holds the header and the sheets stay apart, drawn after the body', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const controls = { methods: { permit: true }, options: OPTIONS };
  await act(async () =>
    root.render(createElement(Page, { request: async () => ({}), chatId: 'c', title: 'Fix', back: () => {}, reload: () => {}, controls })),
  );
  await flush();
  const bar = host.querySelector('[data-part="bar"]')!;
  const body = host.querySelector('main')!;
  const sheets = host.querySelector('[data-part="sheets"]')!;
  assert.ok(bar.querySelector('button[aria-label="Back to chats"]'), 'the Back button is in the bar');
  assert.equal(sheets.querySelector('button[aria-label="Back to chats"]'), null);
  await click('Chat menu');
  await click('Permissions  Default permissions');
  assert.ok(sheets.textContent!.includes('Ask before running commands'), 'the sheet opens inside the sheets part');
  assert.equal(bar.textContent!.includes('Ask before running commands'), false);
  // in document order the sheet follows the body, so it is drawn over it
  assert.ok(body.compareDocumentPosition(sheets) & Node.DOCUMENT_POSITION_FOLLOWING);
  await act(async () => root.unmount());
  host.remove();
});

test('the chat screen draws the header bar first and its sheets after the body', () => {
  const source = readFileSync(new URL('../mobile/src/screens/Thread.tsx', import.meta.url), 'utf8');
  const bar = source.indexOf('{header.bar}');
  const sheets = source.indexOf('{header.sheets}');
  assert.ok(bar > 0 && sheets > bar, 'the bar comes first');
  assert.ok(source.indexOf('<ScrollView', bar) < sheets, 'the sheets come after the transcript');
  assert.ok(source.indexOf('<Composer', bar) < sheets, 'and after the composer');
});
