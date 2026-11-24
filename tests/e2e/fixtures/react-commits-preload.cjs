// Window-side recorder: installs React's DevTools hook in the page's own world before react-dom loads, and counts what each commit rendered while window.__renders.on is true (off, a commit costs one property read). Content-free: counts by the host element's first CSS class, and function components in all.
const { webFrame } = require('electron');

/** Runs in the page's main world. */
function install() {
  const PERFORMED_WORK = 1;
  const HOST_COMPONENT = 5;
  const state = { on: false, commits: 0, components: 0, hosts: 0, byClass: new Map() };
  const classOf = (fiber) => (typeof fiber?.memoizedProps?.className === 'string' ? fiber.memoizedProps.className.split(' ')[0] : '');
  const count = (cls) => cls && state.byClass.set(cls, (state.byClass.get(cls) ?? 0) + 1);
  const visit = (fiber, mounted) => {
    if (fiber.tag === HOST_COMPONENT) {
      // a host element renders when its props are new (React sets no PerformedWork flag on it)
      if (mounted || fiber.alternate?.memoizedProps !== fiber.memoizedProps) {
        state.hosts++;
        count(classOf(fiber));
      }
    } else if (
      (mounted || fiber.flags & PERFORMED_WORK) &&
      (typeof fiber.type === 'function' || (typeof fiber.type === 'object' && fiber.type))
    ) {
      state.components++;
      // a component is told by the class of the first element it draws
      let host = fiber.child;
      while (host && host.tag !== HOST_COMPONENT) host = host.child;
      count(`<${classOf(host) || 'no element'}>`);
    }
    // a subtree React bailed out of keeps its children: nothing in it rendered in this commit
    if (!mounted && fiber.alternate?.child === fiber.child) return;
    for (let child = fiber.child; child; child = child.sibling) visit(child, mounted || !child.alternate);
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberRoot: (_id, root) => {
      if (!state.on) return;
      state.commits++;
      visit(root.current, false);
    },
    onPostCommitFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
  };
  window.__renders = {
    start() {
      state.on = true;
      state.commits = state.components = state.hosts = 0;
      state.byClass.clear();
    },
    stop() {
      state.on = false;
      return {
        commits: state.commits,
        components: state.components,
        hosts: state.hosts,
        byClass: [...state.byClass].sort((a, b) => b[1] - a[1]).slice(0, 20),
      };
    },
  };
}

if (process.isMainFrame) webFrame.executeJavaScript(`(${install.toString()})()`);
