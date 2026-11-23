// Where the Claude Code CLI keeps its user-level config: $CLAUDE_CONFIG_DIR, else ~/.claude, and its sessions' transcripts under
// it. The platform's config roots (fs.cjs), the Claude harness (accounts.cjs, transcripts.cjs) and the request ledger's import read it.
const os = require('node:os');
const path = require('node:path');

const sharedRoot = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
/** Every session's transcript, the CLI's own and MoPilot's: <root>/projects/<project>/<session>.jsonl. */
const projectsRoot = () => path.join(sharedRoot(), 'projects');

module.exports = { sharedRoot, projectsRoot };
