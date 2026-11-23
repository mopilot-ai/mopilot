# Switching a chat across harnesses

## Change contract

The user keeps one MoPilot chat, its project, worktree, draft, history and owned browser tabs when
switching between Codex, Claude Code and any admitted ACP harness, including two different ACP
harnesses. Confirmation applies to the next message. A switch selected during a turn waits for that
turn to finish. Cancel leaves the current harness selected. Switching changes the underlying native
session, not the user-visible chat identity.

Main owns the ordered segment list and message queue. Native-session keys include the complete harness
kind; two ACP harnesses returning the same session identifier must never share history, settings or
events. A retired segment cannot change the current segment's approvals, options or running state.
Native tools bind to the stable chat before their session opens, including with no window present.

The ChatController serializes sends and switch effects per chat. Independent chats can switch
concurrently. Metadata edits made while a switch prepares survive. A failed session preparation or
segment write leaves the old selection authoritative and the message queued for retry. Stop during
preparation prevents dispatch; prepared context remains attached to the queued message as in the
existing switch contract.

## Handoff and recovery

Automatic handoff carries conversation text within the existing context budget, plus workspace and
held targets. Workspace-only handoff deliberately omits conversation. Codex and Claude Code can also
write a summary in a hidden fork; ACP sources offer automatic and workspace-only handoff because the
generic ACP contract does not promise an isolated summarization fork.

Returning to a live or successfully reopened native session sends only intervening conversation. If
an ACP session cannot reopen and the host replaces it, automatic handoff sends the full conversation
instead. A prepared replacement keeps this obligation across failed segment writes and restarts until
its transcript records a successfully completed prompt after the latest session creation. This
distinction follows durable native-session evidence, not a harness-name
allowlist. Reopening the UI rebuilds every segment from its native history and continues the active
ACP stream without duplicating turns. Earlier sessions stay out of the sidebar.

A first-tier chat's saved permission choice does not become a parent-imposed cap when its ACP
destination starts. The adapter settings reader consults the durable linked-session journal: a linked child retains its saved cap across a switch, including
refusing dispatch when the destination cannot represent it. Until that journal is available, a
possible inherited cap stays in force. Returning to the first-tier session retains its own saved
configuration. A replacement native session must establish permission ownership again: a user turn
before the latest native-session record cannot waive a linked child's inherited cap. Context
handoff and permission initialization use the same generation boundary.

ACP models and settings remain the agent's own: a new session starts on its configured defaults; a
returning session restores its recorded choices. Switching never silently maps a first-tier account,
goal or multi-agent setting onto an ACP harness. The shared UI names the selected harness and reports
unavailable operations accurately.

Session updates may arrive while preparation still owns the native session provisionally, before its
segment commits. Every translator-cache read revalidates its stable chat owner, including live replay,
close events and delayed stray-turn cleanup. A translator created by an early command catalog cannot
capture the committed chat's reply, and its timer cannot end a later owner's turn.

Approval cards and notifications name the requesting native harness, even after the chat switches.
Main publishes only a sanitized display kind and retains private answer ownership separately. Host
cards keep their explicit harness hint; legacy cards retain native-segment lookup, while an explicit
unidentified origin uses a neutral label. The window and Chrome side panel share this resolver.

The model picker, permission slot and command controls resolve the same current-or-pending destination
through `useComposerHarness`; reference-read ownership uses the same pending-target resolver. The
composed UI test exercises the current/pending family matrix through actual send and retries after a
pending destination changes during reference preparation: a
model-picker-only test cannot establish that the surrounding composer accepts the new target. Its
fixture must preserve the production distinction between an ACP kind and the ACP family.

MoMo's brain picker uses the same pending-switch mechanism, retaining the main chat and queued input.
ACP brains use their session's own model instead of requiring a first-tier model id. Existing
confinement and availability checks still decide which harnesses can run MoMo.

## Failure scenarios and prevention

The root-cause class is `cross-harness-gaps`: the switch table, picker and history stitcher implemented
only the first-tier pair despite the stable-chat architecture supporting additional native kinds.
The previous acceptance spec asserted this restriction. Replace that expectation with a cross-family
behavior matrix, including two distinct ACP harnesses, rather than adding a special OpenCode path.

Applicable scenarios are A1-A5 (serialized sends, stop, retired events and retry), W1-W3 (metadata and
segment persistence), B1-B4 (session creation, load/replacement, history and errors), and I1-I5 (opaque
native identities, full harness kinds, segment slicing and consistent surfaces). A6 also covers cached translator ownership and delayed stray-turn cleanup across a segment commit.
W4 is inapplicable: no new process-wide paths or rendezvous.
B5 remains owned by the existing ACP RPC timeout and provider-stall paths; switching adds no prompt
or autonomous retry loop. B6 uses the existing claim-before-open tool ownership contract.

Forking a chat containing ACP segments remains unavailable until its adapters support native forks;
it must fail explicitly rather than return an incomplete history. This is a distinct operation from
switching and does not block continuing the chat.
