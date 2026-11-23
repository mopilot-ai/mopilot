// Skills found on disk, for the Skills page before any session has run in a folder: the CLI only
// reports its skills in a session's init message, so until then the page reads the same roots the
// CLI does (the account's config folder and the project's .claude/skills).
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');

/** `name:` from a SKILL.md's front matter, or null. */
function skillName(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const n = m && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(m[1]);
  return n ? n[1] : null;
}

/** Names of the skills under each root (a folder per skill, holding SKILL.md), without duplicates. */
function scanSkills(roots) {
  const out = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      try {
        const name = skillName(fs.readFileSync(path.join(root, e.name, 'SKILL.md'), 'utf8')) ?? e.name;
        if (!out.includes(name)) out.push(name);
      } catch (error) {
        // no SKILL.md (ENOENT, or a file rather than a folder): not a skill
        noteIgnored('read a Claude Code skill', error, ['ENOENT', 'ENOTDIR']);
      }
    }
  }
  return out.sort();
}

/** The roots for an account (its CLAUDE_CONFIG_DIR, else ~/.claude) and an optional project folder. */
function skillRoots(configDir, cwd) {
  return [path.join(configDir, 'skills'), ...(cwd ? [path.join(cwd, '.claude', 'skills')] : [])];
}

module.exports = { scanSkills, skillRoots, skillName };
