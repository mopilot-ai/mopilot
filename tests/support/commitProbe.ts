// Which components rendered in each React commit, read through the DevTools hook React calls on every commit.
// Import this before anything that loads react-dom: React looks for the hook once, when it loads.

type Fiber = {
  type: unknown;
  flags: number;
  memoizedProps: any;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
};

/** React's PerformedWork flag: the component's function ran in this render (a bailout leaves it unset). */
const PERFORMED_WORK = 1;

/** Every component render since the last `resetCommits`, in order: its function name and the props it rendered with. */
export const renders: { name: string; props: any }[] = [];
export const resetCommits = () => {
  renders.length = 0;
};
/** The props of each render of the component named `name` since the last reset. */
export const rendersOf = (name: string) => renders.filter((r) => r.name === name).map((r) => r.props);

/**
 * A component's function name. esbuild (the web tests' loader) renames `function TurnView` inside
 * `const TurnView = memo(…)` to `TurnView2`, so a numeric suffix is dropped.
 */
const nameOf = (fiber: Fiber) =>
  typeof fiber.type === 'function' ? ((fiber.type as { name?: string }).name ?? '').replace(/\d+$/, '') : '';

function visit(fiber: Fiber, mounted: boolean) {
  const name = nameOf(fiber);
  if (name && (mounted || fiber.flags & PERFORMED_WORK)) renders.push({ name, props: fiber.memoizedProps });
  // a subtree React bailed out of keeps its children: nothing in it rendered in this commit
  if (!mounted && fiber.alternate?.child === fiber.child) return;
  for (let child = fiber.child; child; child = child.sibling) visit(child, mounted || !child.alternate);
}

(globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  renderers: new Map(),
  inject: () => 1,
  checkDCE: () => {},
  onScheduleFiberRoot: () => {},
  onCommitFiberRoot: (_id: number, root: { current: Fiber }) => visit(root.current, false),
  onPostCommitFiberRoot: () => {},
  onCommitFiberUnmount: () => {},
};
