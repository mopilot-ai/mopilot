// A card that needs an answer never moves a reader who left the end; the down-arrow says an answer waits so the card is not missed (useFollowEnd, with a stand-in for the list).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRoot } from './support/phone/component-kit';
const followPath = '../mobile/src/remote/useFollowEnd';
const { useFollowEnd } = await import(followPath);

const mounted: { root: any; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
});

/** The hook alone, with a stand-in for the list: what it was asked to scroll to, and what it says. */
async function probe(initial: string) {
  const calls: { y?: number; end?: boolean }[] = [];
  let out: any;
  const Probe = ({ waiting }: { waiting: string }) => {
    out = useFollowEnd('chat', waiting);
    out.ref.current = { scrollTo: (o: { y: number }) => calls.push({ y: o.y }), scrollToEnd: () => calls.push({ end: true }) };
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(Probe, { waiting: initial })));
  const report = (y: number, content: number, view = 600) =>
    act(async () =>
      out.props.onScroll({ nativeEvent: { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } } }),
    );
  return {
    calls,
    out: () => out,
    report,
    waiting: (key: string) => act(async () => root.render(createElement(Probe, { waiting: key }))),
    grow: (h: number) => act(async () => out.props.onContentSizeChange(0, h)),
  };
}

test('a card that needs an answer does not scroll a reader who left the end, however near it is', async () => {
  const p = await probe('');
  await p.report(1400, 2000);
  await p.report(1000, 2000);
  assert.equal(p.out().away, true);
  await p.waiting('approval:1');
  await p.grow(2300);
  await p.grow(2310);
  assert.deepEqual(p.calls, [], 'the view stays where the reader left it');
});

test('a waiting card does not take a reader who is far from the end, nor changes what following does', async () => {
  const far = await probe('');
  await far.report(1400, 3000);
  await far.report(100, 3000);
  await far.waiting('a');
  await far.grow(3300);
  assert.deepEqual(far.calls, [], 'a reader well above is not pulled down');
  const following = await probe('');
  await following.waiting('a');
  await following.grow(2300);
  assert.equal(
    following.calls.every((c) => c.end),
    true,
    'a following chat only follows, no jump to a place',
  );
});

test('the arrow stays while a card waits and says so: an answer is waiting, near the end or far from it', async () => {
  const p = await probe('');
  await p.report(1400, 2000);
  await p.report(1000, 2000);
  assert.equal(p.out().away, true, 'the arrow shows when nothing waits');
  assert.equal(p.out().answer, false, 'and says nothing of an answer');
  await p.waiting('approval:1');
  assert.equal(p.out().away, true, 'the arrow is not hidden by a card below');
  assert.equal(p.out().answer, true, 'it says a card needs an answer');
  await p.report(100, 2000);
  assert.equal(p.out().away, true);
  assert.equal(p.out().answer, true);
  await p.waiting('');
  assert.equal(p.out().answer, false, 'answered: the mark goes');
});

test('a reader at the end sees no arrow and no mark, whatever waits', async () => {
  const p = await probe('');
  await p.report(1400, 2000);
  await p.waiting('approval:1');
  assert.equal(p.out().away, false);
  assert.equal(p.out().answer, false, 'the card is in view or followed: nothing to point at');
});
