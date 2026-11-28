# Orchestrator chat

A session can start independent linked sessions, follow their work and continue when their reports arrive. Codex, Claude Code and admitted ACP harnesses participate as both parent and child, including mixed families and operation without an open window. The main process owns lineage, authority, delivery and persistence; the renderer presents that state.

## Reference and scope

The reference is Claude Desktop 3.6556.2: its packaged main process, cached Code-tab renderer and model-facing tool descriptions. These are static implementation evidence, not a measurement of a live Claude Desktop window. The reference interaction includes the empty offer, user selection, brief construction, successive running and settled cards, input requests, folding, detach, archive, failure recovery and restart.

MoPilot follows that local linked-session experience while retaining mixed harnesses, dependent sessions (`after`), declared write paths and worktree bring-back. Cloud and SSH dispatch require separate platform support. An ACP harness without native transcript fork starts from an explicit conversation excerpt; unavailable model or effort controls report their limitation instead of pretending to apply it.

## Starting sessions

The model decides whether work belongs in another session from the injected “Starting other sessions” paragraph, which sends it to the shared `start_session` tool: its description carries the rules (offer, propose, hand off, link, never poll), so they cost nothing until the tool is loaded. A task of its own can outlive this turn and be opened, steered or reviewed separately. Searching, reviewing and testing one change remain here or in a subagent unless the user asks for a session.

- `initiation: "user_asked"` starts immediately when the user's own words request separate work.
- `initiation: "offer"` needs only a title and asks “New session” or “Do it here” before the model writes the brief. Only one unanswered offer remains active for a parent. The user's choice reserves the exact session and settings; the model then fills it with `proposal_id`, `prompt` and `background`. A late or restarted card can request that brief on a new human turn. It never allocates a replacement worker for the same accepted offer.
- An unanswered offer does not hold the task indefinitely. While its call waits, the card counts down for a minute, with the seconds under the title and a fill across “New session”. If nobody answers, main chooses “New session” for the user, as their click would but on the turn's own start authority (so the approval past ten starts still applies): the call returns the start's result with `answer: "new_session"` and `auto: true`, its `next` asks the model for the reserved session's brief and not to do the task here, and the transcript reads “Started session (no answer)”. A start that fails or is declined leaves the card open, without a countdown, for the user's own answer. Main owns the deadline (the proposal's `countdown`): every window shows the same moment, including one that opens late, and the countdown runs with no window open. Opening the card's start options or “Don’t ask again”, clicking an answer, or starting to type a reply in that chat's composer in the main window stops the countdown: the card then waits for the user until the call's 13-minute cap. Quick Chat keeps its text to itself, so there only a sent message closes the offer. A message the user sends closes the offer instead, whether it steers into the turn or waits in the queue behind it (ACP, a queued follow-up); a queued one has the agent end its turn so the message runs next. A Stop, a harness that quits or the turn's end lets go of the call and leaves the card open. Main times the countdown with its process timer, which macOS pauses while the Mac sleeps, and windows draw the wall-clock deadline: after a wake the card reads “Starting a new session…” until main's timer catches up. Claude Desktop waits for the answer with no default; this is a deliberate difference.
- `initiation: "own_initiative"` leaves a complete proposal for the user to start. A task the user explicitly named is not the model's own initiative. Ordinary turns allow three suggestions; a still-current plan accepted through the real plan button or native root approval allows four independent steps. Text claiming that a plan was approved cannot grant the exception.
- Offers and suggestions expire after a week. Stop, abort, dismissal, superseding user input (steered or queued) and restart release a waiting tool call. A reserved session awaiting its brief stays visible as “Writing the brief…”.

A fresh task needs a prompt and at least 80 characters of background. A fork takes the conversation plus its task. Prompt and background together are bounded to 32,000 characters. The tool result explains what happened and what the model must do next; a reserved session is not reported as already working.

The first ten starts since the last human input need no additional start approval. Later starts ask the user. There is no application-wide parallel-child cap. A busy recipient still queues its own input through its current ChatController; this is per-chat ordering rather than a global slot queue.

Only a main-authored continuation immediately following human-owned orchestration may start an already requested independent step. It always asks for approval and is limited to ten continued starts and five still-working continued sessions. A peer message, scheduled input, stopped turn, mismatched native segment or fabricated wake text cannot acquire that authority.

## Folders, transcripts and settings

A fresh session in a plain folder shares that folder by default. A parent with a managed worktree or retained worktree history defaults to a separate worktree. Explicit `use_worktree` controls fresh placement. Forks of managed worktree sessions use the parent's committed HEAD; fresh worktrees use its source/base branch. Uncommitted changes remain in their original checkout.

Claude linked forks use the SDK's persistent transcript copy, relocate it into the target project's canonical transcript directory and preserve referenced subagent transcripts. The child resumes that durable native session after restart. Ephemeral side chats retain their separate lifetime. Codex uses its native fork. ACP's excerpt fallback is returned explicitly.

Main persists inherited model, effort, permission, account and authorized directories before announcing the child. Agent-proposed models are bounded to the parent's family or cheaper choices; trusted user card choices can select their own model and effort. Permissions never increase implicitly. Each adapter reads current durable settings on later turns, so a historical journal entry cannot overwrite a newer user choice. Initial linked plan mode retains an underlying permission and releases it only on a current real plan exit.

A family has a private notes directory outside the repository. Parent and children receive additive grants; inherited directories and existing permission rules remain intact. Native protocols that cannot widen a currently running turn report that current-turn limitation while retaining the next-turn grant. The directory remains while any live attached, detached or inherited session references it. Final retirement removes only that private grant and directory; a failed persistence or a restore admitted before grant retirement preserves it.

An allocation retired while awaiting worktree creation, settings, transcript reads or approval cannot send a task. A clean worktree may be discarded only before native creation begins, while this starter still owns the allocation. Starting or forking a native session transfers its worktree to the chat's normal lifecycle before the first native callback, including partial failures. A cancelled native child may be archived, but cleanup never removes its folder: the user can restore and send to it while cancellation finishes. Dirty worktrees are retained; cleanup never force-removes them.

## Delivery and persistence

`electron/session/orchestration/journal.cjs` atomically persists links, proposals, reports, delivery metadata, dependencies and per-turn plans. The journal alone owns lineage: a renderer metadata patch cannot forge a parent. A corrupt existing journal is retained and disables orchestration with an actionable error instead of starting empty.

The initial message has CD's readable `Background (from the session that started this one):` and `Task:` sections, or `Task (from the session that started this one):` for a fork. Structured delivery metadata identifies task, context, harness and provenance; the message is not promoted to human input by its readable text.

A refused or rejected first send retains the complete input in the same child's controller queue, or in the durable journal fallback if that queue cannot accept it. The result reports queued or failed delivery truthfully and remains tied to that child. Concurrent retries coalesce by recipient and item; they do not create another worker. Current recipient native identity, archive generation and terminal deletion receipts are checked around asynchronous delivery.

Restart restores proposals and waiting briefs. An open waiting tool call does not survive the process. Queued input drains in recipient order; work with an uncertain native acceptance is not blindly resent. A child that was running when its harness disappeared reports a lost/interrupted turn rather than waking its parent as successful work.

## Reports, family authority and continuation

Each child records historical provenance and an optional detached-lineage flag. Family traversal is bounded to 32 links. Detached sessions retain their history but lose former-family messaging, reporting and start authority. Short handles are unique, at most 24 characters, and reserve `parent`, `self` and `top`.

“Linked sessions now” is status, not an instruction. It lists names, stable chat ids, state and the starter of descendants, plus the dedicated shared-notes path. Follow-ups reach the existing session through its current adapter; they do not create a fresh worker.

A child turn report names the session, ending, branch and PR when known. The app quotes at most 400 Unicode characters from its wrap-up recap or final reply, neutralizing tags, quotes and control characters. A report is data and must be checked before the parent claims completion. At most 32 pending notes are retained.

The parent continues only when it is idle, has no queued input or unanswered request, has a report from a turn it drove and no sibling is still working or starting. A settled child request names the child needing the user; the parent cannot answer it on the user's behalf. Stop or failure holds notes until the next human input. At most ten wakes occur between human messages. A main-owned wake is recognized through its real delivery identity, not matching text inside a file or tool output.

## Sidebar and transcript

The sidebar flattens descendants beneath their top attached ancestor. Recency ordering moves the family to its most recent member. One continuous 1px guide descends from the parent and bends through a 6px radius into the final child midpoint; intermediate children have no horizontal branches. Compact rows are 28px high with 13px text, 2px gaps and one descendant indentation level.

A permanent title caret folds the family and persists that choice. The collapsed summary counts nested, failed, unread and working sessions. Children needing input or open in a pane remain accessible. Working titles shimmer without an extra activity dot; unread, needs-input and error indicators retain distinct meanings. Completion has no “Done” marker. PR badges reflect open, draft, closed and merged state, with a count only for multiple PRs.

Rows expose More options, and linked children can “Detach to top level”. Archiving a parent automatically includes quiet children. Attention, queued/running work, unread state, unfinished worktrees or uncertainty require a choice: archive all sessions shown, or archive this session and detach survivors. Main serializes this effect, rechecks identities after reads and Stop, and preserves children added after the dialog. An ordered archive event closes affected panes. A late completion receipt cannot rearchive a newly restored chat.

Transcript session cards use an outline, 8px corners and hover fill, with a blinking working dot and no elapsed-time or “Done” text. Multiple consecutive sessions form one group while running and after settling. PR state remains on the card; MoPilot's worktree Merge/Open PR controls remain available under their existing ownership checks.

A child's first task shows “Started by {harness} from {parent}”, then Task and Context. Long sections fold at 9em with Show more. Child permission/question requests appear expanded inside the parent's transcript as “Request from {child}”, using the child's actual request owner. A copied fork's historical card can open the original session but cannot answer or mutate its former owner's proposal. Reports read “Received message from {child}”; app continuations identify the app as the trigger. Waiting/held dependencies produce a card rather than disappearing from the UI.

## MoPilot extensions

- `after` allocates a child whose brief waits for named linked predecessors. A failed/stopped/lost predecessor holds it with a visible reason; continuing releases the original full brief once. Waiting work does not hold a parent's wake as running work.
- Shared-folder concurrent writers must declare up to 20 relative path globs. Overlap is refused before allocation. A lone worker needs no declaration. Native edits outside declared paths are recorded and reported, rather than silently treated as within scope.
- Worktree facts come from bounded git/gh reads. Bring-back refuses unsafe merges and reports conflicts; Open PR pushes the child's branch and opens GitHub's form. These controls do not grant parent authority over an unrelated or detached session.
- Harness routing and usage-limit restart offers preserve task context and expose degradation. They do not silently raise model cost or permissions.

## Verification

Focused UT exercise the actual main service, native adapters, IPC and renderer owners, including new input during awaits, archive/restore ABA, concurrent proposals, rejected sends and successful retry. The shared persistent-fork invariant uses the installed SDK and reads the relocated transcript in a new process. Targeted fake-based CI journeys cover offers, parallel starts, persistent Claude forks, request mirrors, several cards, folding, detach, archive and narrow-window geometry. Validation results belong in the PR, not this document. Full live Claude Desktop pixel parity is a separate observation from static-source geometry and MoPilot's own checks.
