// Claude in Chrome in benchmark runs (#1561): its pairing is account-wide, so a Claude session started in the VM can
// drive a Chrome on another device. Bench instances start Claude with it off and vendor arms stop a turn that reaches
// it, unless the run pairs a Claude in Chrome inside the VM and says so (MOPILOT_BENCH_CLAUDE_CHROME=vm-local).

/** The run's own declaration that the account's only paired Claude in Chrome is one inside the VM. */
export const PAIRING_ENV = 'MOPILOT_BENCH_CLAUDE_CHROME';
/** The MoPilot switch that starts Claude Code with --no-chrome (electron/claudeAuth.cjs nativeChromeFor). */
export const CLAUDE_CHROME_OFF = 'native.claude.chrome=0';

/** Whether this run declared a VM-local Claude in Chrome pairing. @param {Record<string, string | undefined>} [env] */
export const vmLocalPairing = (env = process.env) => env[PAIRING_ENV] === 'vm-local';

/**
 * MOPILOT_FLAGS for a bench instance: the run's own switches with Claude in Chrome off (any setting of it the run gave
 * is replaced), or unchanged when the run declared a VM-local pairing.
 * @param {string | undefined} flags @param {Record<string, string | undefined>} [env]
 */
export function benchFlags(flags, env = process.env) {
  const parts = String(flags ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (vmLocalPairing(env)) return parts.join(',');
  return [...parts.filter((p) => p.split('=')[0].trim() !== 'native.claude.chrome'), CLAUDE_CHROME_OFF].join(',');
}

/**
 * Whether a vendor app arm may let its turn use the vendor's Chrome extension: Claude Desktop's (Claude in Chrome) only
 * with a VM-local pairing. Only Claude in Chrome is known to reach browsers on other devices (#1561).
 * @param {{ transcripts?: string }} arm @param {Record<string, string | undefined>} [env]
 */
export const vendorChromeAllowed = (arm, env = process.env) => arm.transcripts !== 'claude' || vmLocalPairing(env);
