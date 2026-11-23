// Kimi Code over ACP: `kimi acp`. Sessions load, resume, list, fork; model, thinking and mode are
// config options (set_config_option); it pushes its commands (/goal with budgets, /swarm, /init,
// /skill:<name>), which pass through. Sign-in is a device code in its own login.
module.exports = {
  label: 'Kimi Code',
  bins: ['kimi'],
  args: ['acp'],
  // nothing is uploaded beyond the model requests themselves
  privacyDefaults: [],
  admission: { handshakeTimeoutMs: 10_000 },
  // plan is a value of the mode config option (ACP_MODES): default asks, plan only reads, auto approves safe operations,
  // yolo approves everything
  plan: { configOption: 'mode', value: 'plan' },
  anchors: { default: 'ask', plan: 'readOnly', auto: 'auto', yolo: 'full' },
  instructionsFiles: ['AGENTS.md'],
};
