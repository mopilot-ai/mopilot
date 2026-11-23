// #5351: the chat list answers every scroll to the end with a scroll report and a momentum end, even from the end itself (every time on iOS 27). A chat that scrolled to the end again on that momentum end made the list answer itself in a loop on the JS thread, and no touch got through: the owner's long chat did not move under a finger.
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

const CAP = 50;
/** A list that answers each scrollToEnd as the native one does: a scroll report at the end, then a momentum end. Counts the calls, and stops answering at CAP. */
async function echoingList(content = 2000, view = 600) {
  let calls = 0;
  let out: any;
  const Probe = () => {
    out = useFollowEnd('chat', '');
    out.ref.current = {
      scrollToEnd: () => {
        if (++calls > CAP) return;
        out.props.onScroll({
          nativeEvent: { contentOffset: { y: content - view }, contentSize: { height: content }, layoutMeasurement: { height: view } },
        });
        out.props.onMomentumScrollEnd();
      },
      scrollTo: () => undefined,
    };
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(Probe)));
  return { calls: () => calls, out: () => out };
}

test('a momentum end that comes from the list already being at the end does not scroll to the end again', async () => {
  const list = await echoingList();
  await act(async () => list.out().props.onContentSizeChange(0, 2000));
  assert.ok(list.calls() >= 1, 'the growth was followed');
  assert.ok(list.calls() <= 2, `the list answered itself ${list.calls()} times`);
});

test('a lift with no speed from the end does not scroll to the end again either', async () => {
  const list = await echoingList();
  await act(async () => list.out().props.onContentSizeChange(0, 2000));
  const before = list.calls();
  await act(async () => list.out().props.onScrollBeginDrag());
  await act(async () => list.out().props.onScrollEndDrag({ nativeEvent: { velocity: { y: 0 } } }));
  assert.equal(list.calls(), before, 'at the end already: nothing to do');
});

test('a momentum end after the content grew while the reader was flicking still catches up, once', async () => {
  const list = await echoingList(2000, 600);
  await act(async () => list.out().props.onContentSizeChange(0, 2000));
  const before = list.calls();
  // the reader flicks (momentum), content grows under it, and the view comes to rest short of the new end
  await act(async () => list.out().props.onScrollBeginDrag());
  await act(async () => list.out().props.onScrollEndDrag({ nativeEvent: { velocity: { y: 1 } } }));
  await act(async () =>
    list
      .out()
      .props.onScroll({ nativeEvent: { contentOffset: { y: 1300 }, contentSize: { height: 2400 }, layoutMeasurement: { height: 600 } } }),
  );
  await act(async () => list.out().props.onMomentumScrollEnd());
  assert.ok(list.calls() - before <= 1, 'one catch-up at most');
});
