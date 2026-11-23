# Render cost

One of the [bug classes](README.md#bug-classes). A pull request adds its note about this class as a file of its own in
`notes/render-cost/` (one note per file), not below; the bullets below are the earlier notes.

Work on a continuous input (a drag, a poll, a resize) that grows with what is on screen rather than with what
changed: a state update per mouse event that renders a whole panel, an effect whose dependency is a new array on
every render, a CSS custom property set on an ancestor of thousands of rows, a poll that replaces data it read
unchanged. Each is cheap on a small chat or diff and freezes the app on a large one (#2049).

## Search for and ask

- Search: `addEventListener('mousemove'` and `onPointerMove` handlers that set React state; `style={{ '--` on an element
  with a large subtree; effect dependency arrays holding a value built during render (`[x]`, `{ ... }`, `.map(...)`);
  `setInterval` or focus re-reads that set state with a freshly built object.
- Ask: *with ten times the rows on screen, what does one mouse move, one frame or one poll cost, and does a frame or
  a poll that changed nothing render anything?*
- Measure on a large case in a dev instance in the VM (`scripts/vm-exec.sh`; AGENTS.md keeps it off the user's Mac) (a diff of thousands of lines, a long chat): a trace of the input, its
  per-event time and the main thread's split between script, style and layout. Unit tests show what renders, not
  what it costs.

## Notes

- #2049: dragging the side pane's edge over a 40-file diff took a second per mouse move. The drag set React state on
  every `mousemove`, re-rendering every diff line; each file's comment surface re-subscribed its listeners because
  its `columns` prop was a new array on every render; `--pane-w`, set on the pane, restyled all ~160k nodes under it;
  and the pane's five-second Git poll rendered and colored the whole diff again when nothing had changed. Edges are
  dragged through `startEdgeDrag` or `frameCoalescer` (src/lib/edgeDrag.ts: one DOM write per frame, state once on
  release; the `[raw-edge-drag]` rule), a drag's custom property stops at the content it does not size (an
  `@property` with `inherits: false`, or `initial` where the subtree does not read it), and a poll keeps what it read
  unchanged (`reuseDiffFiles`).
- #2277: MoMo's Chat tab mounted `ThreadView` in a page that scrolls itself, so the transcript's scroller had no bounded
  height and was as tall as its content. The response room under a sent message was sized from that scroller's height,
  which included the room, so every resize pass grew it again (about 2,000 px a second, to a 3 GB renderer). A size an
  observer writes must not feed the measurement it reads: the room reads `viewHeight` (src/components/thread/view/
  turnWindow.tsx), capped at the window, and a page that hosts a chat bounds it as `.momo-page-chat` does (a flex column
  that does not scroll, `tests/styles.test.ts`). Search for `new ResizeObserver` callbacks that write `style.height` or
  set a height state from `clientHeight`/`scrollHeight` of an element that contains what they size.
