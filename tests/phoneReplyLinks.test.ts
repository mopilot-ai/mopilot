// A link in a reply opens on a tap and offers Open in browser and Copy link on a long press, whether it was written as Markdown or as a bare address (#5116).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const bubblePath = '../mobile/src/components/MessageBubble';
const markdownPath = '../mobile/src/components/Markdown';
const linksPath = '../mobile/src/chatLinks';
const i18nPath = '../mobile/src/ui/i18n';
const { MessageBubble } = await import(bubblePath);
const { Markdown } = await import(markdownPath);
const { ChatLinkContext } = await import(linksPath);
const { showLocale } = await import(i18nPath);
const g = globalThis as any;

async function mount(node: any) {
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, root, done: () => act(async () => root.unmount()) };
}
const links = (host: Element) => [...host.querySelectorAll('[role=link]')] as any[];
const reply = (text: string) => createElement(MessageBubble, { role: 'assistant', text });

test('a bare address in a reply is a link: a tap hands it to iOS, as does [text](url); a www address and an email get their scheme', async () => {
  g.__openedUrls = [];
  const v = await mount(
    reply('Docs: https://example.com/a?b=1. Also www.example.org, me@example.com and [the guide](https://guide.example/x).'),
  );
  assert.deepEqual(
    links(v.host).map((l) => l.textContent),
    ['https://example.com/a?b=1', 'www.example.org', 'me@example.com', 'the guide'],
  );
  for (const link of links(v.host)) await act(async () => link.click());
  assert.deepEqual(g.__openedUrls, [
    'https://example.com/a?b=1',
    'http://www.example.org',
    'mailto:me@example.com',
    'https://guide.example/x',
  ]);
  await v.done();
});

test('next to Chinese text a bare address ends at the full-width punctuation, and the words after it are not part of the link', async () => {
  g.__openedUrls = [];
  const v = await mount(reply('详见https://example.com/x，请看。'));
  assert.deepEqual(
    links(v.host).map((l) => l.textContent),
    ['https://example.com/x'],
  );
  await act(async () => links(v.host)[0].click());
  assert.deepEqual(g.__openedUrls, ['https://example.com/x']);
  assert.match(v.host.textContent!, /详见https:\/\/example\.com\/x，请看。/);
  await v.done();
});

test('a reply that is still streaming draws a bare address as a link with its words fading, then whole', async () => {
  const text = 'Read https://example.com/docs now';
  const v = await mount(createElement(Markdown, { text, fade: true, steps: [{ at: 0, time: Date.now() }] }));
  assert.equal(links(v.host)[0]?.textContent, 'https://example.com/docs');
  assert.equal(v.host.textContent, text);
  await v.done();
});

test('a long press on a link offers Open in browser and Copy link; each does what it says; Cancel does nothing', async () => {
  g.__openedUrls = [];
  g.__clipboard = undefined;
  const v = await mount(reply('See https://example.com/a for more.'));
  const link = links(v.host)[0];
  await act(async () => link.__longPress());
  assert.deepEqual(g.__actionSheet.options, ['Open in browser', 'Copy link', 'Cancel']);
  assert.equal(g.__actionSheet.cancel, 2);
  await act(async () => g.__actionSheet.pick(2));
  assert.deepEqual(g.__openedUrls, []);
  assert.equal(g.__clipboard, undefined);
  await act(async () => g.__actionSheet.pick(0));
  assert.deepEqual(g.__openedUrls, ['https://example.com/a']);
  await act(async () => g.__actionSheet.pick(1));
  await flush();
  assert.equal(g.__clipboard, 'https://example.com/a');
  await v.done();
});

test('the link menu is in the language shown, a chat link opens its chat from it, and without a system sheet the link takes no long press', async () => {
  const opened: string[] = [];
  const v = await mount(
    createElement(ChatLinkContext.Provider, { value: (id: string) => opened.push(id) }, reply('Back to [that chat](mopilot:chat/abc).')),
  );
  await act(async () => showLocale('zh-Hans'));
  g.__actionSheet = undefined;
  await act(async () => links(v.host)[0].__longPress());
  assert.deepEqual(g.__actionSheet.options, ['在浏览器中打开', '复制链接', '取消']);
  await act(async () => g.__actionSheet.pick(0));
  assert.deepEqual(opened, ['abc']);
  await act(async () => showLocale('en'));
  g.__phonePlatform = 'android';
  try {
    g.__actionSheet = undefined;
    const android = await mount(createElement(ChatLinkContext.Provider, { value: () => {} }, reply('See https://example.com/a')));
    assert.equal(
      links(android.host)[0].__longPress,
      undefined,
      'no system sheet: the link takes no long press, so the message keeps its own menu',
    );
    await android.done();
  } finally {
    g.__phonePlatform = undefined;
  }
  await v.done();
});

test('your own message stays plain words, with its addresses as links (a tap opens, a long press offers the menu); backticks and Markdown links are left as written', async () => {
  g.__openedUrls = [];
  const v = await mount(
    createElement(MessageBubble, {
      role: 'user',
      text: 'check https://example.com/a，then `https://code.example` and [t](https://t.example) **x**',
    }),
  );
  assert.deepEqual(
    links(v.host).map((l) => l.textContent),
    ['https://example.com/a'],
  );
  assert.match(
    v.host.textContent!,
    /check https:\/\/example\.com\/a，then `https:\/\/code\.example` and \[t\]\(https:\/\/t\.example\) \*\*x\*\*/,
  );
  await act(async () => links(v.host)[0].click());
  assert.deepEqual(g.__openedUrls, ['https://example.com/a']);
  await act(async () => links(v.host)[0].__longPress());
  assert.deepEqual(g.__actionSheet.options, ['Open in browser', 'Copy link', 'Cancel']);
  await v.done();
  const plain = await mount(createElement(MessageBubble, { role: 'user', text: 'no address here' }));
  assert.equal(links(plain.host).length, 0);
  assert.match(plain.host.textContent!, /no address here/);
  await plain.done();
});

test('only web and mail addresses are opened from a message: a tel:, sms: or custom-scheme link does nothing on a tap and offers Copy link alone', async () => {
  g.__openedUrls = [];
  g.__clipboard = undefined;
  const v = await mount(
    reply(
      'Call [me](tel:+15551234567), [text](sms:123), [x](javascript:alert(1)), [app](fooapp://open?x=1) or [site](HTTPS://Example.com/Up).',
    ),
  );
  const found = links(v.host);
  assert.equal(found.length, 5);
  for (const link of found) await act(async () => link.click());
  assert.deepEqual(g.__openedUrls, ['HTTPS://Example.com/Up'], 'an upper-case scheme is still a web address');
  await act(async () => found[0].__longPress());
  assert.deepEqual(g.__actionSheet.options, ['Copy link', 'Cancel']);
  await act(async () => g.__actionSheet.pick(0));
  await flush();
  assert.equal(g.__clipboard, 'tel:+15551234567');
  await v.done();
});

test('Copy link on an email address copies the address, not mailto:', async () => {
  g.__clipboard = undefined;
  const v = await mount(reply('Write to me@example.com today'));
  await act(async () => links(v.host)[0].__longPress());
  await act(async () => g.__actionSheet.pick(1));
  await flush();
  assert.equal(g.__clipboard, 'me@example.com');
  await v.done();
});
