// Qwen Code over ACP: `qwen --acp`. Its approval modes are ACP modes: plan, default, auto-edit,
// auto, yolo. /goal, /plan, /review, /compress and the rest come through its command list. Usage
// statistics are on unless QWEN_USAGE_STATISTICS_ENABLED says otherwise.
module.exports = {
  label: 'Qwen Code',
  bins: ['qwen'],
  args: ['--acp'],
  env: { QWEN_USAGE_STATISTICS_ENABLED: 'false' },
  privacyDefaults: ['usage statistics (QWEN_USAGE_STATISTICS_ENABLED=false)'],
  admission: { handshakeTimeoutMs: 10_000 },
  anchors: { plan: 'readOnly', default: 'ask', 'auto-edit': 'auto', auto: 'auto', yolo: 'full' },
  plan: { mode: 'plan' },
  // QWEN.md and AGENTS.md; the user-level file is ~/.qwen/QWEN.md
  instructionsFiles: ['QWEN.md', 'AGENTS.md', '~/.qwen/QWEN.md'],
};
