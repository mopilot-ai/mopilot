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

/** `description:` from a SKILL.md's front matter ('' when absent): one line, quoted, or a folded/literal block. */
function skillDescription(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return '';
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at < 0) return '';
  const first = lines[at].slice('description:'.length).trim();
  if (/^[>|][+-]?$/.test(first)) {
    const block = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() && !/^\s/.test(l)) break;
      block.push(l.trim());
    }
    return block.join(' ').trim();
  }
  return first.replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
}

/** The parsed front matter of each SKILL.md read so far, by path, valid while the file's mtime and size are the same. */
const parsed = new Map();

/** `{ name, description }` of a SKILL.md (name null when it has none), read only when the file changed since the last call; null when it can't be read. */
function readSkillFile(file) {
  try {
    const st = fs.statSync(file);
    const kept = parsed.get(file);
    if (kept && kept.mtimeMs === st.mtimeMs && kept.size === st.size) return kept;
    const text = fs.readFileSync(file, 'utf8');
    const next = { mtimeMs: st.mtimeMs, size: st.size, name: skillName(text), description: skillDescription(text) };
    parsed.set(file, next);
    return next;
  } catch (error) {
    // no SKILL.md, or one that can't be read: nothing to open, and nothing to keep
    parsed.delete(file);
    noteIgnored('read a Claude Code skill', error, ['ENOENT', 'ENOTDIR', 'EACCES', 'EISDIR']);
    return null;
  }
}

/**
 * Where each skill's SKILL.md is: name -> { name, path (absolute), description, scope }. A skill is addressable by its front
 * matter name and by its folder name (a plugin's skills as `<plugin>:<name>`). Earlier roots win a shared name: the CLI's own
 * precedence is personal over project, and plugin skills are namespaced so they never collide. Within a root every front matter
 * name is taken before any folder name, so a folder name never shadows another skill's own name.
 * @param {{ dir: string, scope: string, prefix?: string }[]} roots
 */
function indexSkills(roots) {
  const out = new Map();
  for (const { dir, scope, prefix = '' } of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const found = [];
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const file = path.join(dir, e.name, 'SKILL.md');
      const read = readSkillFile(file);
      if (read)
        found.push({
          folder: prefix + e.name,
          entry: { name: prefix + (read.name ?? e.name), path: file, description: read.description, scope },
        });
    }
    for (const { entry } of found) if (!out.has(entry.name)) out.set(entry.name, entry);
    for (const { folder, entry } of found) if (!out.has(folder)) out.set(folder, entry);
  }
  return out;
}

/** The index's roots for an account, an optional project folder and the catalog's plugins ({ name, path }). */
function indexRoots(configDir, cwd, plugins = []) {
  return [
    { dir: path.join(configDir, 'skills'), scope: 'personal' },
    ...(cwd ? [{ dir: path.join(cwd, '.claude', 'skills'), scope: 'project' }] : []),
    ...plugins.filter((p) => p?.path && p.name).map((p) => ({ dir: path.join(p.path, 'skills'), scope: 'plugin', prefix: `${p.name}:` })),
  ];
}

/** `skillFiles` for the names a catalog lists: { name: { path, description, scope } } for those that resolve. */
function skillFilesFor(names, configDir, cwd, plugins) {
  if (!names.length) return {};
  const index = indexSkills(indexRoots(configDir, cwd, plugins));
  // fromEntries defines own keys, so a skill named `__proto__` is an entry like any other
  return Object.fromEntries(
    names.flatMap((n) => {
      const hit = index.get(n);
      return hit ? [[n, { path: hit.path, description: hit.description, scope: hit.scope }]] : [];
    }),
  );
}

module.exports = { scanSkills, skillRoots, skillName, skillDescription, indexSkills, indexRoots, skillFilesFor };
