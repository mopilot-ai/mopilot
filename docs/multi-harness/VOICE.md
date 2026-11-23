# Voice input across harnesses

Status: proposed design. Research snapshot: 2026-10-24. This document defines the intended behavior;
it does not assert that a proposed adapter has passed a live audio or authenticated-service check.

## Decision

Voice input belongs to the current MoPilot chat. It must preserve the selected harness, model,
account, project, permission mode and attachments. Starting voice must never route another harness's
chat to Codex or create a Codex chat as an implicit fallback.

Prefer a harness's native implementation when it supports the requested operation through a usable,
verified integration. Keep a separately selected shared transcription provider available for every
harness. Neither local recognition nor a vendor subscription is assumed to work merely because the
platform, CLI or account exists.

Four operations have different contracts:

| Operation | Result | Starts an agent turn? |
| --- | --- | --- |
| Dictate | Editable text inserted into the current draft | No |
| Send audio | An audio message submitted to the current agent | Yes, only on Send |
| Voice conversation | A continuous, interruptible conversation in the current chat | According to the native conversation protocol |
| Speak reply | Playback of an existing assistant response | No |

An adapter may support any subset. An audio prompt is not a transcription-only API. Reply playback is
independent of voice input and is not required to deliver the requested input improvement.

## Findings and evidence boundaries

### Codex

The existing application integrates thread-scoped realtime voice using WebRTC and
`thread/realtime/start`. The generated protocol marks this experimental. The current renderer sends
`version: 'v3'`, `model: 'gpt-live-1-codex'` and audio output. Its account gate requires a usable ChatGPT
subscription login. These are observations of this checkout, not a promise about every Codex version.

Relevant source: `src/session/voice.ts`, `src/protocol/v2/ThreadRealtimeStartParams.ts`,
`electron/session/voice.cjs`, `electron/session/caps.cjs`, and `electron/harness/codexLeases.cjs`.
The existing ChatGPT dictation route in `electron/platform/voice.cjs` is a separate transcription
service; it does not require changing the chat's execution harness.

The protocol's `clientManagedHandoffs` flag controls response forwarding. Its declaration alone does
not establish an agent-neutral speech service or eliminate the Codex thread's ownership and side
effects. Do not use a hidden Codex thread as Claude/ACP's default voice engine.

Official OpenAI documentation describes the [app-server integration](https://learn.chatgpt.com/docs/app-server)
and distinguishes [voice workflows](https://developers.openai.com/api/docs/guides/audio). Versioned
generated protocol types remain the evidence for the experimental methods used by this application.

### Claude Code

The [official CLI documentation](https://code.claude.com/docs/en/voice-dictation) establishes native
dictation that streams audio to Anthropic, requires a Claude.ai login, and is subject to organization
policy. It is not available through direct API-key or cloud-provider configurations. Its language
table omits Chinese, while its submission discussion mentions Chinese segmentation; Chinese support
must be verified for the selected implementation rather than inferred from either paragraph.

The repository pins Agent SDK 0.3.295. Public declarations from that package and registry-current
0.3.310 were inspected. `Query.streamInput` accepts `SDKUserMessage`; its message uses Anthropic
`MessageParam`. The inspected Query/control request contracts expose no external PCM stream or
transcription start/finalize/cancel API. `Settings.voice`, `voiceEnabled` and a command-output type that
mentions `/voice` do not provide that transport. The pinned Anthropic SDK 0.132.1's declared message
content union has no raw audio input block.

MoPilot exposes no Claude-native transcription provider. Claude and ACP chats can use the shared
local, ChatGPT-account or MoPilot-credit transcription services without switching their execution
harness. The app does not read Claude credentials for dictation or advertise an unavailable transport.

Do not scrape the terminal UI or enable `/voice` blindly inside a headless SDK session.

### ACP and named agents

MoPilot currently speaks ACP v1. Its `negotiate()` drops the optional audio capability, `acpBlocks()`
builds text/images/resource links, and `sendPrompt()` validates images but has no audio capability
guard. All three need extending for native audio messages.

[ACP v1 audio content](https://agentclientprotocol.com/protocol/v1/content) is an audio block in
`session/prompt`, gated by `agentCapabilities.promptCapabilities.audio === true`. It does not define
a transcription-only service or a duplex microphone session. Do not use the v2 draft capability
shape in the existing v1 parser.

| Agent | Upstream evidence | Design consequence |
| --- | --- | --- |
| Gemini CLI | [Initialization](https://github.com/google-gemini/gemini-cli/blob/cd1b45c2db0a5ea7b7fc3b67c1ba5879601d6005/packages/cli/src/acp/acpRpcDispatcher.ts#L91) advertises audio; [conversion](https://github.com/google-gemini/gemini-cli/blob/cd1b45c2db0a5ea7b7fc3b67c1ba5879601d6005/packages/cli/src/acp/acpSession.ts#L960) forwards it as inline data | Native audio-message candidate; selected model/provider and MIME still need checking |
| Qwen Code | [ACP initialization](https://github.com/QwenLM/qwen-code/blob/52b0574b2509b5595006b34ca1e905d382b0f8b5/packages/cli/src/acp-integration/acpAgent.ts#L5587) advertises audio | Native audio-message candidate; the CLI's separate dictation requires a configured [voice model](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/) |
| Kimi CLI | [Initialization](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/acp/server.py#L98) declares `audio=False` | That snapshot does not support ACP audio prompts; offer explicitly selected shared transcription |
| OpenCode | [ACP initialization](https://github.com/anomalyco/opencode/blob/8fd2ec1b72bde36ba3835ae974377b32feaa013d/packages/cli/src/acp/service.ts#L121) omits audio | No advertised ACP audio in that snapshot |
| OpenCode native server | [Experimental voice routes](https://github.com/anomalyco/opencode/blob/8fd2ec1b72bde36ba3835ae974377b32feaa013d/packages/protocol/src/groups/voice.ts#L48) broker WebRTC/WebSocket sessions using provider credentials | Separate integration candidate; binding its voice session to the existing ACP chat is unestablished |
| dsh, Copilot CLI, Cursor CLI, Goose | No callable native speech contract established in this bounded research | Unknown; use actual negotiated capabilities, never a name-based assumption |

These are pinned upstream source observations, not checks of the user's installed agents. Runtime
initialization, version and actual provider/model acceptance decide availability. Gemini and Qwen
must retain their existing agent authentication: MoPilot sends audio over ACP, not to an invented
Gemini/Qwen transcription endpoint.

### Shared transcription and the meaning of local

The application already has three shared providers in `electron/platform/voice.cjs`:

| Choice | Who receives audio | Prerequisites |
| --- | --- | --- |
| This Mac | Apple Speech on the machine running MoPilot | macOS, helper, microphone and speech permission, available language recognizer, device-side recognition support |
| ChatGPT account | Existing ChatGPT transcription backend | An explicitly selected usable ChatGPT login |
| MoPilot credits | Configured MoPilot gateway | MoPilot sign-in, service availability and billing capability |

`native/helper/Sources/ComputerUseHelper/Speech.swift` checks `isAvailable` and
`supportsOnDeviceRecognition`, then sets `requiresOnDeviceRecognition = true`. This is not a bundled
Whisper model and is not guaranteed to exist for every language or machine. Its `auto` locale is the
system locale, not automatic spoken-language detection. The current implementation returns a whole
clip's final result; it must not advertise live partial captions without a streaming implementation.
Apple documents the same [device-side capability prerequisite](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition).

The current default resolver selects local on a new Mac profile without checking these prerequisites.
Replace that assumption with a readiness check. An unknown status is unknown, not ready. Never
silently upload a failed local clip to a cloud provider.

## Product interaction

Keep the microphone's default action as **Dictate**: record, transcribe, insert editable text, then let
the user Send. A small menu exposes **Send audio** where the current adapter supports it, and
**Voice conversation** where a native conversation adapter is ready. The composer must not hide its
typed draft merely because an unavailable conversation path was selected.

- Starting from an existing chat never opens another chat. Starting from a new-chat draft preserves
  its selected kind/model/account; dictation creates no native chat, and Send creates the chosen one.
  A native conversation may create its own current-harness chat after the user starts that mode.
- Dictation shows the selected speech service and editable transcript. Native audio mode shows an
  audio attachment with duration, playback and Remove; Send submits it as the user's task. Never
  manufacture a transcript or start an agent turn to obtain a draft.
- The old cross-harness confirmation and summary checkbox disappear. First-use information names
  the actual audio service/account, independent of the task's harness.
- When native integration is unavailable, show the reason and an explicit shared-provider choice.
  Example: “Claude Code transcription is not connected. Choose a dictation service.” Local is listed
  as ready only after its actual checks; a denied service offers its relevant recovery.
- Honor a saved shared-service choice. A new `preferNative` preference considers only a verified
  implementation of the same operation. Moving to another vendor requires a user choice, not an
  automatic provider cascade or reuse of `voiceRouteConfirmed` as consent.
- A hotkey targets the focused composer, including split views and new-chat drafts. If no composer
  is present, the existing Quick Chat surface may open with the user's selected default harness.
- Stop recording finalizes a dictation clip. Cancel discards the active attempt. End conversation
  closes audio/conversation resources. Agent Stop remains a separate action; pending native
  conversation transcript tails must not start a surprise task when the call ends.
- Switching chat/harness/account pauses recording and retires the old attempt. Retain unsent text or
  audio at its original draft. Require explicit restart at the destination. A recording never follows
  focus into another chat.
- Three consecutive recordings produce three intentional insertions/messages. Partial revisions,
  native echo notifications and reloads must not duplicate them or concatenate unrelated segments.

Do not add shared text-to-speech as an implicit dependency. Existing Codex native spoken replies
remain available through its conversation mode; any future shared playback advertises its own
service and availability.

## Architecture and capability contract

Use one main-process speech service with typed adapter bindings, integrated into `CapsService`.
Keep the current cap states (`native`, `sage`, `disabled`, `absent`) and structured reasons. Audio
input is negotiated separately from dictation and `voiceChat`; unknown capability never becomes a
route to Codex. Global ChatGPT-account gates must apply only to their actual native/provider path.

```text
Composer / hotkey / Chrome panel
        -> main speech service -> resolved operation binding
             | dictate: native ASR or selected shared ASR -> owning editable draft
             | send audio: current adapter -> ChatController -> current native session
             | conversation: current native realtime adapter + chat writer coordination
```

Proposed contract sketch, to be placed with the existing typed adapter contracts:

```ts
type SpeechOperation = 'dictate' | 'audioMessage' | 'conversation' | 'speakReply';
type SpeechReadiness = 'ready' | 'needsPermission' | 'blocked' | 'unknown';
type SpeechBinding = {
  operation: SpeechOperation;
  implementation: 'native' | 'shared';
  readiness: SpeechReadiness;
  reason?: string;
  serviceLabel: string;
  accountId?: string;
  support: 'publicProtocol' | 'privateCompatibility' | 'platform';
  capture: 'clip' | 'pcmStream' | 'webrtc';
  mimeTypes: string[];
  language: string | null; // null means unknown, not unrestricted
};
```

The service resolves operation bindings from current adapter/version/session, account, provider/model,
language, microphone and platform facts. A native transport that merely exists in source remains
`unknown`/`blocked` until its integration prerequisites pass. Protocol capability and model acceptance
are separate facts: ACP `audio:true` is necessary, not a guarantee for an arbitrary configured model.

The window captures microphone samples under an opaque attempt ID; main owns admission, service
connections and ordered events. Raw vendor credentials never cross the renderer bridge. A capture
window closing ends recording; accepted agent work continues through the existing controller without
a window. Do not move background task execution back into renderer voice state.

Each preload document receives a main-generated lease synchronously, through a lightweight handler
registered before the first window loads. Speech calls carry that lease internally. Main-frame
navigation, renderer crash and window destruction retire it; same-document routing and subframe
navigation do not. A replacement page receives a fresh lease even when its WebContents id is reused.
Retirement closes the original capture and prepared transfers, and asynchronous cleanup retains its
original lease throughout. A retired or detached document cannot mutate its replacement's input.

Unsent audio drafts persist as independent document-owned fragments. Another live window cannot
claim them. Closing their document or restarting the app makes them recoverable as editable input,
combining distinct text drafts and attachment references for review. This recovery never submits a
task. Pending submissions have durable ownership before the composer clears, and queued submissions
remain paused for explicit review after restart. Persist recovered fragments before releasing their
pending references. Failed draft writes retain both the last durable references and unsaved media
until recovery or a successful replacement write.

Extend the existing send contract for audio attachments, not a parallel agent loop. `ChatController`
owns queueing, permissions, turn events and stop/retry. `acpBlocks` emits an ACP audio block only after
capability, MIME, size and media validation, and `sendPrompt` checks it again immediately before RPC.
Persist a referenced audio asset and display metadata, not base64 blobs in every state snapshot.
Transcript rendering, native replay, export, handoff and retention/deletion need the same attachment
contract. A corrupt/missing asset remains a recoverable failed message, not an empty successful send.

Submitted and pending audio use a durable media asset store, separate from dictation's rolling
last-20 recordings and its Clear action. Drafts, queued sends, the submission journal and persisted
message history hold references. Commit reference changes before collecting unreferenced assets;
restart recovery preserves assets whose submission state is unresolved. A failed reference write
cannot delete the prior asset. Archive retains history; explicit deletion follows the chat/asset
ownership policy, including shared references and export. Clearing recent dictation recordings must
never erase a pending or historical audio message.

A text handoff carries explicit recording references and their untranscribed status, including outside generated summaries and transcript trimming. It does not submit the old audio task again. A recipient without the original native audio context must ask for Dictate text or a newly attached recording on an audio-capable agent. Workspace-only handoff deliberately omits conversation history. Recent references are bounded, and omitted older recordings remain explicitly counted in source history.

Native acceptance also precedes optional naming and window notifications. A title/history read or a closed-window notification must never reject or replay accepted work.

Native realtime is an exclusive chat writer. Preserve its original native segment lease in main and
coordinate with ordinary sends: a conflicting text send is retained until realtime ends, or is
forwarded only through a verified native append operation. Never dispatch competing native turns
merely because both UI controls are enabled.

A Stop acknowledgment alone does not confirm native closure. Keep the writer until the original
closure notification or server exit; a bounded timeout exposes failure without enabling a competing
writer. Chrome side-panel readiness has a ten-second deadline below its RPC deadline, and cancelled
or expired preparations cannot reserve a microphone after their late readiness response.

### Claude native integration gate

A native adapter must use a documented, versioned transport with start, audio, finalize, cancel
and transcript/error events. Credential refresh and locking belong to the CLI. Until that upstream
interface is available and verified, report the native binding as unavailable and offer shared
transcription. Do not read the CLI's stored access token or infer a usable API from a terminal command.

## Change contract and failure scenarios

**Invariant:** every intentional speech result reaches its original draft/chat at most once, through
the selected operation and service; recovery never changes its harness, account or audio recipient.
For task submission this means no duplicate client dispatch for one intentional submission ID, not
an unsupported guarantee about execution inside an external agent.

**Owner:** stable MoPilot chat ID or provisional draft token, segment identity/revision, task account,
speech account and credential generation, window/capture owner, language and attempt generation.
Changing any material owner dimension retires in-flight reads and unsubmitted effects. Draft-to-chat
creation is an explicit ownership transfer. After an accepted send, the controller owns the input;
closing voice or its window must not delete accepted work or replay it.

**Overlap:** coalesce equivalent capability reads within a full owner identity; the latest changed
read wins. Serialize microphone ownership across windows and audio frames within one stream. Keep
every independent user insertion/edit; replace only the current utterance's partial text range.
Serialize accepted audio tasks through the existing per-chat send queue. Store a stable submission
ID and receipt; an ambiguous transport failure is reconciled before any resend. Do not promise
exactly-once delivery where a native service offers no idempotency/reconciliation mechanism.

Distinguish local queue admission, native dispatch and confirmed native acceptance. ACP v1 does not
guarantee an idempotency key or a way to correlate history after a lost connection; a locally returned
turn ID is not proof the agent accepted the prompt. If dispatch may have reached the agent and no
reliable correlation is available, enter `deliveryUnknown`, end the waiting indicator, retain media
and stop automatic replay/retry. Show “Delivery could not be confirmed; the agent may have started
this task.” Offer inspect/reconcile where supported, or explicit **Send again** as a new intentional
submission with a new ID. An unresolved journal record must not auto-dispatch after restart.

**Pending and recovery:** connecting/transcribing/finalizing have deadlines and visible cancel/retry.
No progress means no useful transcript/connection advance, not just receipt of keepalives. Finalized
text survives a later playback/save failure. Partial text promoted by a compatibility adapter after
an error is marked incomplete and is never auto-submitted as a complete command. Recoverable audio
stays with its original attempt until Retry/Remove or established retention cleanup.

Implementation UT must map the applicable A/W/B/I scenarios from
`docs/bug-prevention/change-contract.md` to real production entrypoints with mocked boundaries:

| Scenario | Required evidence |
| --- | --- |
| A1-A5 | Start/replace/cancel, both completion orders, old rejection after new success, window close, Strict Mode remount, account/harness/draft switch at each await |
| A6 | Any timeout/reconnect throttle: refused/failed attempts do not consume a successful attempt's cooldown; fake-clock boundary cases |
| W1-W3 | Typing during partial recognition; two windows; reversed acknowledgments; queue/asset persistence failure; original input remains recoverable |
| W2/B2 | Agent receives audio and starts work, then transport fails without a correlatable acknowledgment: `deliveryUnknown`, no automatic replay, explicit new-send intent only |
| W3 | More than 20 later dictations, Clear recordings, restart and failed reference writes cannot delete audio referenced by a draft, queue, unresolved journal or persisted chat history |
| W4 | A speech worker or helper isolation change, if introduced, preserves credential-lock and stream rendezvous identities; otherwise no process-layout change |
| B1-B5 | Malformed events, wrong types, duplicate segment boundaries, partial-only termination, no speech, endless keepalives, permission/account/provider/MIME rejection and bounded finalization |
| B6 | If a native bridge caches capability/config at startup, changes retire it before reuse; otherwise no tool-list or cached-native-capability change |
| I1-I5 | Opaque IDs, full account/segment identity, reload after native ID change, shared UI availability decisions, real producer IDs through the receiving checker |

A whole-repository invariant should prohibit implicit cross-harness voice routes and exercise the
shared availability decider on every entry surface. Provider parsers share normalization instead of
duplicating per-composer guards. Existing routing tests that assert a new Codex chat must be rewritten.

Adversarial counterexample: the user dictates “delete src/foo.ts” intending to inspect the draft.
Calling `session/prompt` to obtain its transcript starts a real coding task before Send. Separate
dictation/audio-message contracts prevent this; test the full entrypoint, not only an audio serializer.

## Implementation slices and acceptance

The production seams to change are:

| Responsibility | Current seam and proposed owner |
| --- | --- |
| Operation contracts and availability | `src/harness/adapter.ts`, `shared/caps.mjs`, `electron/session/caps.cjs`; extend typed negotiation and resolve in main |
| Voice lifetime and provider adapters | Extract renderer lifecycle from `src/session/voice.ts`; main speech service owns attempts and native/shared bindings; renderer retains capture/playback only |
| Implicit routing and confirmation | `src/harness/entries.ts`, `src/session/voiceAccess.ts`, `src/components/dialogs/Dialogs.tsx`, `electron/harness/bindings.cjs`; remove the Codex route and global needs-Codex fix |
| Existing native realtime | `electron/session/voice.cjs` and Codex lease handling; wrap as a current-adapter operation and coordinate writers |
| ACP audio path | `electron/harness/acp/agent.cjs`, `electron/harness/acpTurns.cjs`, `electron/harness/acp/prompt.cjs`; negotiate, preserve media and check before dispatch |
| Shared transcription | `electron/platform/voice.cjs`, `src/components/ui/Dictation.tsx`, `src/lib/localSpeech.ts`; readiness and normalized results, not platform-only defaults |
| Entry surfaces | Composer/voice strip, `useComposerVoice`, Dictation, settings and `electron/app/chromePanelDictate.cjs`; one availability decision and operation-specific actions |
| Saved media and history | Durable audio asset ownership alongside attachment/history services, separate from rolling recent dictation recordings; referenced retention and replay |

Choose cohesive new modules during implementation; do not grow the existing large renderer/controller
files simply to host the shared service. No shared registry of adapter paths or new tests is needed.

1. **Shared ownership and UI:** add the typed operation contract and main speech owner; remove implicit
   cross-harness routing; reuse current transcription providers with actual readiness checks. Carry
   legacy explicit engine choices forward, but never infer provider consent from old route confirmation or saved recording history.
2. **Native current-session paths:** wrap Codex realtime without changing its recipient; add ACP v1
   audio negotiation, attachments, serialization, display/replay and failure recovery. Verify Gemini
   and Qwen against the installed negotiated versions before advertising their audio mode.
3. **Claude native gate:** a native adapter requires a documented, supported transport. Until then,
   shared transcription remains available and Claude native dictation stays absent.
4. **Parity and migration:** route composer, focused hotkey, Quick Chat and Chrome panel through the
   shared decider. Preserve MoMo's local-only restriction and selection-comment dictation's no-agent
   semantics. Keep native Codex voice selection separate from other providers' settings. Update the
   old voice exception in `DESIGN.md` and regenerate the harness matrix when implementation lands.

Each implementation PR requires focused UT with enforced 100% line, branch and function coverage
for new/modified behavior; measured scope/results belong in the PR. Broad regression, integration,
E2E/CUJ and conformance suites remain release-only. Native audio checks run on GitHub macOS or an
isolated VM, never by launching another MoPilot instance on the user's Mac.

Acceptance covers empty/new chat, existing chat, denied/unavailable input, edits before Send,
actual task execution, retry without duplication, restart/replay and three recordings back to back.
Claude and ACP must work without Codex installed or signed in when a chosen speech path is ready.
For Codex native conversation, verify lease cleanup and transcript-tail behavior. For Claude native
ASR, verify selected-login ownership and language support. For ACP, verify a native audio prompt
reaches the same session/model and its history retains the audio message.

The complete design is not a claim of universal native-ASR availability. Supported, degraded and
blocked cases remain visible until each adapter meets its own acceptance gate.

## Reproducible research anchors

- Checkout inspected: `844817f273c4e68eaf7189a5ac26f3a5d23142f3`.
- Agent SDK package sources: [0.3.295](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.295.tgz)
  and [0.3.310](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.310.tgz).
  Pinned declarations: `sdk.d.ts` Query 2847, streamInput 3215, SDKControlRequestInner 5017,
  SDKUserMessage 6287, Settings.voice 9162. These are version-specific line anchors.
- Agent SDK tar SHA-256: 0.3.295 `704b1228401f951e1cdb3a1782b97893d3caee64afe162a4f7fbda8106273c7b`;
  0.3.310 `110e2584420b1feff99694efafc58fdb2f35d7a0c5230abe152c1d82fee0384c`.
