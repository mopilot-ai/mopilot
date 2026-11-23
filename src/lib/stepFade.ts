// Fade a streaming reply's words in on the document timeline, so a word that mounts again resumes its fade instead of restarting it.

// Each word span carries `data-fade-at`: the moment, on the document timeline (performance.now's clock), its fade
// begins (its step's time plus its stagger, rehypeWords.ts). The fade is a Web Animation started at that moment
// with `fill: backwards`, as Claude Desktop's delta-fade is. A word that Markdown mounts again (a list turned loose
// wraps it in a paragraph) gets a new element with the same moment: its fade carries on where it was, and a word
// whose fade has ended shows as it is. A CSS animation would start again on every new element.

/** How long a word takes to fade in (Claude Desktop's 400 ms). */
export const FADE_MS = 400;

type Fading = Pick<Element, 'getAttribute'> & { animate?: Element['animate'] };

/**
 * Start the fade of each `.fw[data-fade-at]` element in `root` that has not had one, on the timeline at its moment.
 * `now` is the timeline's current time. Elements in `done` are skipped, and every element seen is added to it.
 */
export function fadeWords(root: { querySelectorAll(selector: string): Iterable<Fading> }, done: WeakSet<object>, now: number) {
  for (const el of root.querySelectorAll('.fw[data-fade-at]')) {
    if (done.has(el)) continue;
    done.add(el);
    const at = Number(el.getAttribute('data-fade-at'));
    if (!Number.isFinite(at) || now >= at + FADE_MS || typeof el.animate !== 'function') continue;
    const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'linear', fill: 'backwards' });
    fade.startTime = at;
  }
}

type Observed = { querySelectorAll(selector: string): Iterable<Fading>; ownerDocument: Document | null };

/**
 * Fade the words in `root` now and those added under it later, each once, without walking the whole reply again on
 * every step: only what each change adds is looked at. Returns the stop.
 */
export function watchFades(root: Observed & Node, Observer: typeof MutationObserver = MutationObserver): () => void {
  const done = new WeakSet<object>();
  const doc = root.ownerDocument;
  const now = () => (doc ? timelineNow(doc) : performance.now());
  fadeWords(root, done, now());
  const observer = new Observer((records) => {
    const at = now();
    for (const record of records)
      for (const node of record.addedNodes)
        if (node.nodeType === 1) {
          const el = node as unknown as Element;
          fadeWords(
            { querySelectorAll: (selector) => [...(el.matches(selector) ? [el] : []), ...el.querySelectorAll(selector)] },
            done,
            at,
          );
        }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** The document timeline's current time, which is performance.now's clock in a window. */
export function timelineNow(doc: Document = document): number {
  const t = doc.timeline?.currentTime;
  return typeof t === 'number' ? t : performance.now();
}
