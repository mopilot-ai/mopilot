// The skills the fake Claude CLI lists beside fake-skill: those found under $CLAUDE_CONFIG_DIR/skills, and each skill as a command.
import fs from 'node:fs';
import path from 'node:path';

/** Folder names under `<configDir>/skills` that hold a SKILL.md (a linked folder counts), as the CLI lists the account's own skills. */
export function diskSkills(configDir) {
  const root = path.join(configDir, 'skills');
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(root, e.name, 'SKILL.md')))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** A skill as the CLI lists it among its commands. */
export const skillCommand = (name) => ({
  name,
  description: name === 'fake-skill' ? 'A skill the fake knows' : `Skill ${name} from the config folder`,
  argumentHint: '',
});
