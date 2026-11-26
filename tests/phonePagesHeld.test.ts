// Whether a chat's Mac pages from the rows it holds: asked once per connection, an answer for an earlier connection or a gone screen counts for nothing, and a Mac that could not be asked is asked again when it next answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';
import { waitFor } from './support/waitFor';
// the path is a variable, so the root typecheck does not take the whole phone app in with this file
const hookPath = '../mobile/src/remote/usePagesHeld';
const { usePagesHeld } = await import(hookPath);

const answerOf = (held: boolean) => ({ capabilities: { methods: ['chat.read'], olderRowsHeld: held } });
const pause = (ms: number) => act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const out: { cheap: boolean; again: () => void } = { cheap: false, again: () => {} };
const Probe = ({ request }: { request: any }) => {
  const { cheap, askAgain } = usePagesHeld(request);
  out.cheap = cheap;
  out.again = askAgain;
  return null;
};
const mount = async (request: any) => {
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe, { request })));
  return {
    root,
    render: (next: any) => act(async () => root.render(createElement(Probe, { request: next }))),
    done: () => act(async () => root.unmount()),
  };
};

test('an answer is read once, and asking again after it was answered asks nothing', async () => {
  let asked = 0;
  const request: any = async () => (asked++, answerOf(true));
  const t = await mount(request);
  await waitFor(() => out.cheap, 'the answer', { step: () => pause(5) });
  await act(async () => out.again());
  await pause(20);
  assert.equal(asked, 1);
  await t.done();
});

test('an answer for an earlier connection says nothing about the one that replaced it', async () => {
  let release: (v: unknown) => void = () => {};
  const slow: any = () => new Promise((resolve) => (release = resolve));
  const fresh: any = async () => answerOf(false);
  const t = await mount(slow);
  await pause(20);
  await t.render(fresh);
  await pause(20);
  await act(async () => release(answerOf(true)));
  await pause(20);
  assert.equal(out.cheap, false, 'the new connection said no, and the old one is not heard');
  await t.done();
});

test('an answer that comes after the screen is gone is dropped', async () => {
  let release: (v: unknown) => void = () => {};
  const slow: any = () => new Promise((resolve) => (release = resolve));
  const t = await mount(slow);
  await pause(20);
  await t.done();
  await act(async () => release(answerOf(true)));
  await pause(20);
  assert.equal(out.cheap, false);
});

test('a Mac that could not be asked is asked again, and the answer then counts', async () => {
  let up = false;
  const request: any = async () => {
    if (!up) throw new Error('Connect to a computer first');
    return answerOf(true);
  };
  const t = await mount(request);
  await pause(30);
  assert.equal(out.cheap, false);
  up = true;
  await act(async () => out.again());
  await waitFor(() => out.cheap, 'the second ask', { step: () => pause(5) });
  await t.done();
});
