# Sidebar collapse and conversation navigation

Reference: two supplied screenshots of the Codex app's sidebar and conversation rail. The behavior below is MoPilot's own design.

## Sidebar collapse

The expanded sidebar width is kept apart from its open/closed state. Dragging past half the minimum expanded width closes the sidebar, and closing does not overwrite the stored expanded width, so reopening restores a usable panel instead of a near-zero width.

MoPilot previously clamped pointer movement and keyboard resizing at 200px. This change lets the panel follow the pointer below 200px down to zero, snapping to zero within 48px of the closed edge. On release below 100px it closes through the existing `sidebarOpen` state, retaining the previously saved width. Releasing at or above 100px retains an expanded sidebar of at least 200px. Below the normal minimum, content is clipped at a readable layout width rather than squeezed into narrow wrapped rows.

The resize handle belongs to the frame rather than to the sidebar and remains reachable at its closed edge. A drag can reverse after snapping to zero without releasing pointer capture. After releasing to close, dragging that same edge right previews the sidebar and commits its expanded width on release. Pointer cancellation restores the starting width without saving or closing. The existing title-bar toggle and sidebar shortcut reopen the saved width. A focused resize separator supports Left/Right; Left at the minimum or Home closes it, and End expands to the available maximum. At zero width the sidebar divider is removed while an 8px resize target remains at the frame edge. A focused collapsed handle opens with Right. The icon rail stays available, as in the reference.

## Conversation navigation

The small horizontal marks in the reference screenshot are a floating user-message navigation rail: one mark per user message, a hover preview with the prompt and an excerpt of the reply, click and drag to jump, and bookmarks. The title and preview make it possible to recognize a previous exchange before jumping to it. A fixed rail also remains reachable after the project sidebar is hidden. Dragging is particularly useful when a long response or tool transcript occupies several screens.

## MoPilot implementation

Both the sidebar repair and the conversation rail are now implemented. `TurnNavigation.tsx` attaches to each `ThreadView` and operates only on that view's scroll container, including side chats and read-only sub-agent views.

- Compact marks appear at four user messages, or sooner when older history or a loaded bookmark is available. The current message is determined from the viewport, including when a long response has scrolled its prompt out of view.
- Hover opens a prompt/response preview after 150ms. Keyboard focus opens it immediately. The card stays interactive while moving into it to toggle a bookmark, and shows up to three response lines and two output indicators.
- At rest every mark has the same short length; the current message is shown by color only. Only the hovered or scrubbed mark grows to full length, and its neighbors one, two and three marks away grow to 70%, 40% and 20%. While another mark is hovered the current mark drops its highlight. Growth animates `transform`, and narrow views use a smaller maximum length.
- Clicking a mark dismisses its preview while jumping. Pointer focus does not reopen it; document pointer movement also dismisses a preview after leaving both the rail and card, covering missed leave events. Pointer entry also clears keyboard retention, and all conversation views share one preview owner so switching views cancels older cards and pending opens. Keyboard focus still permits tabbing into the bookmark control. Follow-ups without their own reply omit the response excerpt instead of showing a placeholder sentence.
- Clicking a mark or the preview title jumps to its user message. Holding and dragging vertically browses messages immediately. The mark list scrolls automatically while the pointer is held at an edge, and releasing a drag suppresses the extra click.
- Option/Alt + Up/Down jumps between messages in the focused conversation. A focused mark also supports Up/Down/Home/End to explore previews, and Enter/Space to jump. Escape and outside clicks dismiss the preview.
- The transcript reserves a gutter for the rail. Container queries reduce its footprint in narrow windows and side panes, and the preview stays within the viewport. Reduced-motion settings disable smooth jumps and mark transitions.

`threadNavigation.ts` shares final-response selection with the transcript. It uses the existing `presentItems`, user-text parsing, directive stripping, plan/review card selection, and attachment labels. Follow-up prompts have separate anchors; earlier prompts show their own available replies, and the last prompt receives the final answer. Empty context-only messages, compaction-only turns, and voice-session flush messages do not produce empty marks. Preview links and images render as text, so a hover does not fetch remote image content or trigger transcript actions.

The rail exposes loaded history and an explicit **Load earlier messages** control. Each request uses the existing 30-turn pagination. Users can load additional pages and browse them; the rail does not claim to index unloaded history or fetch every full turn on mount. Requests from the transcript and rail share one pending operation. Loading preserves a message's document position rather than using the total scroll-height increase, which can also include a growing live reply. A navigation destination takes precedence over that preservation, so loading cannot override a more recent jump. Failed loads show an error and leave the control available for retry.

Jumping pauses automatic following of new output. Manual scrolling releases that navigation lock; reaching the bottom or using the existing bottom button resumes following. Scroll restoration and shortcuts are scoped to the current view, and an obsolete history request cannot reposition another chat after switching conversations.

Bookmarks live in the existing per-chat metadata as an additive `navigationBookmarks` array. This uses the existing atomic persistence and cross-window chat synchronization rather than replacing a global preferences map. Old records without the field load with no bookmarks. IDs use the turn and message IDs for Codex/ACP; Claude's live and transcript turn IDs are normalized to the prompt UUID plus the user-message position within that turn. Temporary messages whose IDs are not yet stable cannot be bookmarked.

Archiving retains bookmarks. Deleting a chat clears its bookmark state. A fork has its own chat namespace and starts without inherited bookmarks. A rewound or removed message has no navigation mark; stale saved IDs cannot jump to an unrelated position. Partial history does not prune bookmarks for messages that have not been loaded yet.

The existing right-side SummaryPanel still covers changes, plans, and related resources for the conversation. The rail supplies a preview and destination for each exchange and remains usable while that panel is closed or the project sidebar is hidden.

## Evidence and verification boundaries

To verify a change here, run `npm run test:coverage -- --changed --suite navigation --suite sidebar-resize`. The suites exercise the production navigation and resize components with mocked layout and network boundaries, and per-chat metadata persistence. They do not cover CSS layout, transitions or physical pointer behavior, which need a live visual check.
