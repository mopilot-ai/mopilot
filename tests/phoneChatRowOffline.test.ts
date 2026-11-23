// A chat row's spoken state says when its computer is offline, in the word the rest of the phone uses for the computer it is connected to (#5320: computer, not Mac); a chat on a Host says where it runs instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
const rowPath = '../mobile/src/components/ChatRow';
const linkPath = '../mobile/src/macLink';
const { ChatRow } = await import(rowPath);
const { MacLinkProvider } = await import(linkPath);

async function spoken(state: any, chat: object) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        MacLinkProvider,
        { state },
        createElement(ChatRow, { chat: { id: 'a', title: 'Write docs', state: 'idle', ...chat }, open: () => {} }),
      ),
    ),
  );
  await flush();
  const text = host.querySelector('button')!.getAttribute('aria-valuetext') ?? '';
  await act(async () => root.unmount());
  host.remove();
  return text;
}
const paired = { pairs: [{ pairId: 'p1', macId: 'm1', name: 'Studio' }], selectedPair: 'p1', user: { id: 'u' }, presence: {} };

test('a chat on a computer that is away says the computer is offline; one on a computer that is there, or on a Host, does not', async () => {
  assert.match(await spoken({ ...paired, phase: 'offline' }, {}), /Your computer is offline/);
  assert.doesNotMatch(await spoken({ ...paired, phase: 'online' }, {}), /offline/);
  const onHost = await spoken({ ...paired, phase: 'offline' }, { hostId: 'h1' });
  assert.match(onHost, /Runs on a host/);
  assert.doesNotMatch(onHost, /offline/);
});
