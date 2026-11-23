// A reply on the phone reads as its rendered text, never its Markdown source, and a link in it stays reachable on its own (#4259).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
const bubblePath = '../mobile/src/components/MessageBubble';
const { MessageBubble } = await import(bubblePath);

async function render(role: string, text: string) {
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MessageBubble, { role, text })));
  return host;
}
const labels = (host: Element) => [...host.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label')!);

test('a reply is not one element labelled with its Markdown source', async () => {
  const host = await render(
    'assistant',
    'See **bold** and [Open linked target](mopilot:chat/acp:gemini-cli:2222).\n\n```js\nconst x = 1;\n```\n\n![diagram](a.png)',
  );
  assert.deepEqual(
    labels(host).filter((l) => /\]\(|\*\*|```/.test(l)),
    [],
  );
  assert.match(host.textContent!, /See bold and Open linked target\./);
  assert.match(host.textContent!, /diagram/);
});

test('a link in a reply is its own element, not inside a labelled container', async () => {
  const host = await render('assistant', '[Open linked target](mopilot:chat/claude:a)');
  const link = host.querySelector('[role="link"]')!;
  assert.equal(link.textContent, 'Open linked target');
  for (let el: Element | null = link; el && el !== host; el = el.parentElement) assert.equal(el.getAttribute('aria-label'), null);
});

test('a user bubble keeps its speaker and text label', async () => {
  const host = await render('user', 'hello');
  assert.deepEqual(labels(host), ['You: hello']);
});
