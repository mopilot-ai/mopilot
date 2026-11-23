// Temporary plugin folders and Claude-format plugin contents shared by reader and store tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-plugins-'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** A Claude-layout plugin the way the official marketplace ships one. */
function claudePlugin(root: string, o: { name?: string; version?: string; mcp?: string } = {}) {
  write(
    path.join(root, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: o.name ?? 'stripe', version: o.version ?? '0.10.3', author: { name: 'Stripe' } }),
  );
  write(path.join(root, 'skills/test-cards/SKILL.md'), '---\nname: test-cards\ndescription: Cards\n---\nbody');
  fs.mkdirSync(path.join(root, 'skills/empty'), { recursive: true });
  write(path.join(root, 'skills/README.md'), 'not a skill');
  write(path.join(root, 'commands/explain.md'), '---\ndescription: Explain\n---\n$ARGUMENTS');
  write(path.join(root, 'commands/deep/nested.md'), 'nested');
  write(path.join(root, 'commands/notes.txt'), 'ignored');
  write(path.join(root, 'agents/researcher.md'), '---\nname: company-researcher\n---\n');
  write(
    path.join(root, 'hooks/hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hi' }] }] } }),
  );
  write(path.join(root, '.mcp.json'), o.mcp ?? JSON.stringify({ mcpServers: { stripe: { type: 'http', url: 'https://mcp.stripe.com' } } }));
  write(path.join(root, '.git/HEAD'), 'ref');
  return root;
}

export { tmp, write, claudePlugin };
