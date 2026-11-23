# Bounded ACP form questions

MoPilot handles session-scoped `elicitation/create` requests with explicit `mode: "form"`. Live ACP sessions advertise `clientCapabilities.elicitation.form: {}`; temporary authentication/admission connections do not. There is no URL-mode capability or URL completion flow.

## Ownership and responses

A form belongs to the exact native connection, typed JSON-RPC request ID, and live ACP session. Its separate frontend ID cannot choose another connection. Only a trusted app window currently viewing that chat may answer; secondary panes and read-only contexts display disabled controls. Main revalidates both the current native segment and the answer before claiming the request synchronously. Two windows can submit only one response.

The user explicitly chooses Submit (`accept` with typed content), Decline, or Cancel. Defaults only populate editable drafts. Invalid draft fields do not prevent Decline or Cancel. Questions never become permission grants or change turn-running state. Existing native permission selections and Codex/Claude cards retain their contracts.

Local transport acceptance means **written**, not that the agent received or consumed the answer. A synchronous transport exception is terminal because bytes might already have been accepted. An IPC failure permits retry only after an authoritative snapshot confirms that the same request is still pending. There is no reconnect replay. Process/connection close, Stop, session close/reset/unbind, and reauthentication retire pending owners. A stale native segment cannot open another pending card; its retirement updates only its own existing card IDs and preserves newer owners. Normal turn completion does not retire a session-scoped question. Closing a window does not cancel it.

Outside-session `requestId` scope is deliberately unsupported and receives cancellation error `-32800`, without guessing a focused chat. Invalid/mixed scope or unsupported form schemas receive `-32602`; an unavailable session receives `-32800`. Native `$/cancel_request` settles the original request using `-32800`. Duplicate live inbound IDs on the same connection cannot replace the original; string and number IDs remain distinct.

## Schema and draft limits

Supported schemas are flat objects containing strings, titled/untitled string choices, string-array choices, booleans, and finite safe-range numbers/integers. Required fields, defaults, bounds and opaque choice values are preserved and validated. Choice/length intersections must contain at least one valid value; choices are never silently filtered or rewritten. Optional null schema annotations are treated as absent. Unsupported semantics (including arbitrary patterns, nested objects, and credential-like prompts, including bearer/session/personal access token requests) fail closed. Unknown string formats remain display hints, not validation guarantees. Numeric drafts reject conversions that change the decimal value, including nonzero underflow and subnormal rounding. Exact equivalent decimal spellings, integral exponent notation and supported schema defaults remain supported; there is no separate renderer digit limit.

Limits: 24 fields, 64 choices per field, 4,096 characters per text value, 65,536 characters per schema/answer, 24 pending forms per session and 128 retained request owners across the host. Answer content is not persisted by the question registry. Each window keeps at most 128 recently edited drafts in memory, retaining them across card remounts. Drafts are not shared with other windows or saved to disk; closing/reloading the window loses them.

## Source compatibility is not runtime acceptance

The standard route follows [ACP's pinned elicitation specification](https://github.com/agentclientprotocol/agent-client-protocol/blob/3be9cfc8ea2dfe5a28973b461fd956b4045f24d3/docs/protocol/v1/elicitation.mdx). Focused fake-transport tests use source-derived schema shapes from:

- [Kimi Code 2.1.1](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%402.1.1/packages/acp-server/src/question.ts): required titled single/multiple choices; its native question tool does not support Other text.
- [Goose 1.54.0](https://github.com/aaif-goose/goose/blob/cd643d2126fffab4c6a6186905211ba868d6a657/crates/goose/src/acp/server/elicitation.rs): negotiated standard forms.
- [OpenCode 2.0.32 source](https://github.com/anomalyco/opencode/blob/63c1a27af5a391d9caa55b82694f496911e1859b/packages/cli/src/acp/elicitation.ts): standard forms, including explicit custom-text schema fields. Historical admission version 1.18.35 did not establish this route.

No provider was upgraded, launched, authenticated, or sent a real turn to validate this slice. None of the eight ACP harnesses has question-flow runtime acceptance from these tests; issue #298 remains open. Qwen's separate permission-metadata/answers extension, Cursor's unverified version/session envelope, dsh's excluded elicitation surface, Gemini's missing ACP answer payload, and Copilot's unverified ACP contract remain outside this implementation. Markdown is never parsed into questions and free text is never encoded as a permission option ID.
