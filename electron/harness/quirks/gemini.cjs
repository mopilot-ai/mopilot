// Gemini CLI over ACP: `gemini --acp`. Plan mode is on by default in the CLI; it reads GEMINI.md and
// skills under .gemini/skills and .agents/skills. Its usage statistics (privacy.usageStatisticsEnabled)
// are ON by default in 0.63; privacyDefaults stays empty because turning them off through a settings
// file (GEMINI_CLI_SYSTEM_SETTINGS_PATH) hasn't been shown to work without a sign-in (human-needed.md).
module.exports = {
  label: 'Gemini',
  bins: ['gemini'],
  args: ['--acp'],
  privacyDefaults: [],
  admission: { handshakeTimeoutMs: 10_000 },
  // its session modes (buildAvailableModes): default prompts, autoEdit approves edits, yolo approves everything, plan only reads
  anchors: { default: 'ask', autoEdit: 'auto', yolo: 'full', plan: 'readOnly' },
  plan: { mode: 'plan' },
  instructionsFiles: ['GEMINI.md', '~/.gemini/GEMINI.md'],
};
