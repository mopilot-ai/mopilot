// Native whole/cut Claude forks and durable linked forks: SDK conversation remapping, then linked transcript placement in the child's project.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude's project keys use real paths, macOS NFC and a signed 31-based hash after the first 200 slug characters. */
async function projectFolder(cwd, io = fs.promises, platform = process.platform) {
  const full = path.resolve(cwd);
  const resolved = await io.realpath(full).catch(() => full);
  const canonical = platform === 'darwin' ? resolved.normalize('NFC') : resolved;
  const slug = canonical.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) hash = ((hash << 5) - hash + canonical.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** Legacy flat agent files are copied only when an actual native Agent/Task result in this conversation names them. */
function referencedAgents(text) {
  const records = text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const content = (r) => (Array.isArray(r.message?.content) ? r.message.content : []);
  const calls = new Set(
    records.flatMap((r) =>
      content(r)
        .filter((b) => b?.type === 'tool_use' && ['Agent', 'Task'].includes(b.name))
        .map((b) => b.id),
    ),
  );
  const ids = new Set();
  for (const record of records)
    for (const block of content(record)) {
      if (block?.type !== 'tool_result' || !calls.has(block.tool_use_id)) continue;
      const id = record.toolUseResult?.agentId;
      if (typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id)) ids.add(id);
      if (typeof block.content === 'string')
        for (const match of block.content.matchAll(/\bagentId:\s*([a-zA-Z0-9_-]+)/g)) ids.add(match[1]);
    }
  return [...ids];
}

/** Repoint only transcript routing fields; user text and the SDK's remapped message identities stay intact. */
function inFolder(text, cwd, sessionId) {
  return (
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const record = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid copied Claude transcript');
        if ('cwd' in record) record.cwd = cwd;
        if ('sessionId' in record) record.sessionId = sessionId;
        return JSON.stringify(record);
      })
      .join('\n') + '\n'
  );
}

/**
 * The source's located project root owns the copy, including when the active login changed. The SDK does the
 * supported UUID/chain remapping; its mutation API copies within the source project, which is moved before resume.
 */
function createLinkedClaudeFork({ sdk, findTranscript, io = fs.promises }) {
  return async (sessionId, cwd, /** @type {{ check?: () => void, validate?: (id: string) => void }} */ { check, validate } = {}) => {
    const source = await findTranscript(sessionId);
    if (!source) throw new Error('Cannot fork: the parent transcript was not found');
    const { forkSession } = await sdk();
    check?.();
    const result = await forkSession(sessionId);
    const id = result?.sessionId;
    if (typeof id !== 'string' || !UUID.test(id) || id === sessionId)
      throw new Error('Cannot fork: the SDK returned an invalid new session id');
    validate?.(id);
    const originalCopy = path.join(path.dirname(source), `${id}.jsonl`);
    const targetDir = path.join(path.dirname(path.dirname(source)), await projectFolder(cwd, io));
    const target = path.join(targetDir, `${id}.jsonl`);
    const sourceAgents = path.join(path.dirname(source), sessionId, 'subagents');
    const targetAgents = path.join(targetDir, id, 'subagents');
    let written = false;
    let agentsOwned = false;
    try {
      const text = inFolder(await io.readFile(originalCopy, 'utf8'), cwd, id);
      const legacyAgents = referencedAgents(text);
      await io.mkdir(targetDir, { recursive: true, mode: 0o700 });
      // A copied UUID is unique; an unexpected existing destination is never overwritten.
      await io.writeFile(target, text, { flag: target === originalCopy ? 'w' : 'wx', mode: 0o600 });
      written = true;
      const hasAgents = await io.stat(sourceAgents).then(
        () => true,
        (error) => {
          if (error?.code !== 'ENOENT') throw error;
          return false;
        },
      );
      if (hasAgents || legacyAgents.length) {
        // Reserve this identity before copying, so rollback never deletes somebody else's pre-existing directory.
        await io.mkdir(path.dirname(targetAgents), { mode: 0o700 });
        agentsOwned = true;
        if (hasAgents) await io.cp(sourceAgents, targetAgents, { recursive: true, errorOnExist: true, force: false });
        if (legacyAgents.length) await io.mkdir(targetAgents, { recursive: true, mode: 0o700 });
        for (const agent of legacyAgents) {
          const file = `agent-${agent}.jsonl`;
          const legacy = path.join(path.dirname(source), file);
          const exists = await io.stat(legacy).then(
            () => true,
            (error) => {
              if (error?.code !== 'ENOENT') throw error;
              return false;
            },
          );
          if (!exists) continue;
          await io.copyFile(legacy, path.join(targetAgents, file), fs.constants.COPYFILE_EXCL).catch((error) => {
            // A modern copy already present is authoritative over its legacy spelling.
            if (error?.code !== 'EEXIST') throw error;
          });
        }
      }
      if (target !== originalCopy) await io.unlink(originalCopy);
      return { sessionId: id };
    } catch (error) {
      // Only paths owned by the SDK-assigned new identity are removed, never the parent or a pre-existing target.
      const cleanup = [originalCopy, ...(written ? [target] : []), ...(agentsOwned ? [path.join(targetDir, id)] : [])];
      for (const file of new Set(cleanup))
        await io
          .rm(file, { recursive: true, force: true })
          .catch((failure) => noteIgnored('clean an incomplete linked Claude fork', failure));
      throw error;
    }
  };
}

module.exports = { createLinkedClaudeFork, inFolder, projectFolder, referencedAgents };
