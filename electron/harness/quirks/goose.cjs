// Goose over ACP: `goose acp` (stdio; goose serve's HTTP interface isn't used). Its modes are auto
// (the default: approves every tool call), approve (asks for each), smart_approve (asks for sensitive
// ones) and chat (no tool calls). It needs a provider set (GOOSE_PROVIDER or `goose configure`)
// before session/new works. Its one auth method ("Configure Provider") answers authenticate without
// configuring anything, so signing in runs `goose configure` in a terminal instead.
module.exports = {
  label: 'Goose',
  bins: ['goose'],
  args: ['acp'],
  privacyDefaults: [],
  admission: { handshakeTimeoutMs: 10_000 },
  loginCommand: ['goose', 'configure'],
  anchors: { chat: 'readOnly', approve: 'ask', smart_approve: 'ask', auto: 'full' },
};
