// The chat's follow hook alone under a composer-growth provider, with the list's calls recorded (#5686): the room and arrow tests drive it through the list's own props.
import { act, createElement, createRoot } from './component-kit';

// by a path in a variable, as the tests do: the root type check must not follow it into the phone's sources (and React Native's timer types)
const followPath = '../../../mobile/src/remote/useFollowEnd';
const originPath = '../../../mobile/src/sendOrigin';
const framePath = '../../../mobile/src/remote/frameLift';
const { useFollowEnd } = await import(followPath);
const { reportSentTop } = await import(originPath);
const { ComposerGrowthContext } = await import(framePath);

const mounted: { root: any; host: HTMLElement }[] = [];
/** Unmounts every probe mounted since the last call (each test's afterEach). */
export async function unmountProbes() {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
}

/** The hook alone, with the list's calls recorded. */
export async function probe(growth: { extra: number } | null = null) {
  const to: { y?: number; animated?: boolean }[] = [];
  const end: unknown[] = [];
  let out: any;
  const Probe = () => {
    out = useFollowEnd('chat', '');
    out.ref.current = {
      scrollTo: (o: { y: number; animated?: boolean }) => to.push(o),
      scrollToEnd: (o: unknown) => end.push(o),
      getInnerViewRef: () => (globalThis as any).__phoneInner,
    };
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(ComposerGrowthContext.Provider, { value: growth }, createElement(Probe))));
  return {
    to,
    end,
    out: () => out,
    report: (y: number, content = 2000, view = 600) =>
      act(async () =>
        out.props.onScroll({
          nativeEvent: { contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: view } },
        }),
      ),
    grow: (h?: number) => act(async () => out.props.onContentSizeChange(0, h)),
    layout: (h: number) => act(async () => out.props.onLayout({ nativeEvent: { layout: { height: h } } })),
    touch: () => act(async () => out.props.onTouchStart()),
    drag: () => act(async () => out.props.onScrollBeginDrag()),
    keyboard: (name: string) => act(async () => (globalThis as any).__keyboardListeners[name]?.()),
    pin: () => act(async () => out.pin()),
    sentTop: (y: number, refine = false) => act(async () => reportSentTop(y, refine)),
  };
}
