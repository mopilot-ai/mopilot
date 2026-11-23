// A linked Claude fork survives process recreation in its own folder, preserves subagent history and never overwrites another session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const GUARDS = ['electron/', 'package-lock.json', 'package.json'];

const require = createRequire(import.meta.url);
const { createLinkedClaudeFork, inFolder, projectFolder, referencedAgents } = require('../electron/harness/claude/linkedFork.cjs');

async function fixture(t: any, extras: any = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-fork-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects', '-parent');
  await fs.mkdir(project, { recursive: true });
  const parent = crypto.randomUUID();
  const id = crypto.randomUUID();
  const source = path.join(project, `${parent}.jsonl`);
  await fs.writeFile(source, 'parent');
  const originalCopy = path.join(project, `${id}.jsonl`);
  const copied = {
    type: 'user',
    uuid: 'new-message',
    parentUuid: null,
    sessionId: id,
    cwd: '/parent',
    message: { content: 'old /parent' },
  };
  const sdk = async () => ({
    forkSession: async (sid: string) => {
      assert.equal(sid, parent);
      await fs.writeFile(originalCopy, JSON.stringify(copied) + '\n');
      return { sessionId: id };
    },
  });
  const fork = createLinkedClaudeFork({ sdk, findTranscript: async () => source, ...extras });
  return { root, project, parent, id, source, originalCopy, copied, fork };
}

test('SDK copy moves to the new cwd, retains identity/content and carries nested subagent transcripts', async (t) => {
  const f = await fixture(t);
  const agents = path.join(f.project, f.parent, 'subagents');
  await fs.mkdir(path.join(agents, 'nested'), { recursive: true });
  await fs.writeFile(path.join(agents, 'nested', 'agent-1.jsonl'), 'agent transcript');
  const result = await f.fork(f.parent, '/child/worktree');
  assert.deepEqual(result, { sessionId: f.id });
  const targetDir = path.join(f.root, 'projects', '-child-worktree');
  const record = JSON.parse(await fs.readFile(path.join(targetDir, `${f.id}.jsonl`), 'utf8'));
  assert.deepEqual(record, { ...f.copied, cwd: '/child/worktree' });
  assert.equal(await fs.readFile(path.join(targetDir, f.id, 'subagents', 'nested', 'agent-1.jsonl'), 'utf8'), 'agent transcript');
  await assert.rejects(fs.stat(f.originalCopy), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.source, 'utf8'), 'parent');
  // A newly constructed reader has everything on disk; it needs no runtime forkFrom or original process.
  assert.equal(JSON.parse(await fs.readFile(path.join(targetDir, `${result.sessionId}.jsonl`), 'utf8')).sessionId, result.sessionId);
});

test('same-folder copy remains durable without moving and can have no subagents', async (t) => {
  const f = await fixture(t);
  await f.fork(f.parent, '/parent');
  assert.equal(JSON.parse(await fs.readFile(f.originalCopy, 'utf8')).cwd, '/parent');
  assert.equal(await fs.readFile(f.source, 'utf8'), 'parent');
  assert.equal(inFolder('{"type":"summary"}\n', '/a', 'new'), '{"type":"summary"}\n');
});

test('the linked fork validates the returned UUID before rewriting or cleaning native files', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.fork(f.parent, '/another-workspace', {
      validate(id: string) {
        assert.equal(id, f.id);
        throw new Error('That session already has an owner.');
      },
    }),
    /already has an owner/,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(f.originalCopy, 'utf8')), f.copied);
  assert.equal(await fs.readFile(f.source, 'utf8'), 'parent');
});

test('missing parent, SDK rejection and invalid new identities fail before registration or parent mutation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(createLinkedClaudeFork({ findTranscript: async () => null })(f.parent, '/child'), /parent transcript/);
  await assert.rejects(
    createLinkedClaudeFork({
      findTranscript: async () => f.source,
      sdk: async () => ({
        forkSession: async () => {
          throw new Error('sdk unavailable');
        },
      }),
    })(f.parent, '/child'),
    /sdk unavailable/,
  );
  for (const id of [undefined, {}, 'bad/id', f.parent])
    await assert.rejects(
      createLinkedClaudeFork({ findTranscript: async () => f.source, sdk: async () => ({ forkSession: async () => ({ sessionId: id }) }) })(
        f.parent,
        '/child',
      ),
      /invalid new session/,
    );
  await assert.rejects(
    createLinkedClaudeFork({ findTranscript: async () => f.source, sdk: async () => ({ forkSession: async () => null }) })(
      f.parent,
      '/child',
    ),
    /invalid new session/,
  );
  assert.equal(await fs.readFile(f.source, 'utf8'), 'parent');
});

test('malformed copied content is refused and cleanup errors do not hide the original failure', async (t) => {
  const f = await fixture(t);
  for (const text of ['not json', 'null', '[]']) {
    const fork = createLinkedClaudeFork({
      findTranscript: async () => f.source,
      sdk: async () => ({ forkSession: async () => (await fs.writeFile(f.originalCopy, text), { sessionId: f.id }) }),
    });
    await assert.rejects(fork(f.parent, '/child'));
    await assert.rejects(fs.stat(f.originalCopy), { code: 'ENOENT' });
  }
  const fork = createLinkedClaudeFork({
    findTranscript: async () => f.source,
    sdk: async () => ({ forkSession: async () => ({ sessionId: f.id }) }),
    io: {
      ...fs,
      readFile: async () => {
        throw new Error('read failed');
      },
      rm: async () => {
        throw new Error('cleanup failed');
      },
    },
  });
  await assert.rejects(fork(f.parent, '/child'), /read failed/);
});

test('an existing destination transcript or agent directory is never overwritten or removed', async (t) => {
  const f = await fixture(t);
  const targetDir = path.join(f.root, 'projects', '-child');
  await fs.mkdir(targetDir);
  const target = path.join(targetDir, `${f.id}.jsonl`);
  await fs.writeFile(target, 'belongs to another writer');
  await assert.rejects(f.fork(f.parent, '/child'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(target, 'utf8'), 'belongs to another writer');
  await fs.rm(target);
  await fs.mkdir(path.join(f.project, f.parent, 'subagents'), { recursive: true });
  await fs.mkdir(path.join(targetDir, f.id));
  await fs.writeFile(path.join(targetDir, f.id, 'keep'), 'keep');
  await assert.rejects(f.fork(f.parent, '/child'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(targetDir, f.id, 'keep'), 'utf8'), 'keep');
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('subagent lookup/copy failures roll back this copy and a retry can still succeed', async (t) => {
  const f = await fixture(t);
  const fork = (io: any) =>
    createLinkedClaudeFork({
      findTranscript: async () => f.source,
      sdk: async () => ({ forkSession: async () => (await fs.writeFile(f.originalCopy, JSON.stringify(f.copied)), { sessionId: f.id }) }),
      io,
    });
  await assert.rejects(
    fork({
      ...fs,
      stat: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    })(f.parent, '/child'),
    /denied/,
  );
  await fs.mkdir(path.join(f.project, f.parent, 'subagents'), { recursive: true });
  await assert.rejects(
    fork({
      ...fs,
      cp: async () => {
        throw new Error('copy failed');
      },
    })(f.parent, '/child'),
    /copy failed/,
  );
  const targetDir = path.join(f.root, 'projects', '-child');
  await assert.rejects(fs.stat(path.join(targetDir, f.id)), { code: 'ENOENT' });
  await f.fork(f.parent, '/child');
  assert.ok((await fs.stat(path.join(targetDir, `${f.id}.jsonl`))).isFile());
});

test('independent concurrent forks preserve both SDK-assigned identities', async (t) => {
  const f = await fixture(t);
  const ids: string[] = [];
  const fork = createLinkedClaudeFork({
    findTranscript: async () => f.source,
    sdk: async () => ({
      forkSession: async () => {
        const id = crypto.randomUUID();
        ids.push(id);
        await fs.writeFile(path.join(f.project, `${id}.jsonl`), JSON.stringify({ ...f.copied, sessionId: id }));
        return { sessionId: id };
      },
    }),
  });
  const results = await Promise.all([fork(f.parent, '/child'), fork(f.parent, '/child')]);
  assert.deepEqual(new Set(results.map((r: any) => r.sessionId)), new Set(ids));
  for (const id of ids) assert.ok((await fs.stat(path.join(f.root, 'projects', '-child', `${id}.jsonl`))).isFile());
});

test('the installed SDK really remaps UUIDs and its relocated copy remains readable after a new process', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'x'.repeat(110), 'y'.repeat(110));
  await fs.mkdir(target, { recursive: true });
  const alias = path.join(f.root, 'alias');
  await fs.symlink(target, alias);
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const records = [
    {
      type: 'user',
      uuid: first,
      parentUuid: null,
      sessionId: f.parent,
      cwd: '/parent',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'original prompt' },
    },
    {
      type: 'assistant',
      uuid: second,
      parentUuid: first,
      sessionId: f.parent,
      cwd: '/parent',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'original reply' }] },
    },
    { type: 'file-history-snapshot', messageId: first, snapshot: {} },
  ];
  await fs.writeFile(f.source, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const script = `const {createLinkedClaudeFork}=require('./electron/harness/claude/linkedFork.cjs');
    const sdk=()=>import('@anthropic-ai/claude-agent-sdk');
    createLinkedClaudeFork({sdk,findTranscript:async()=>process.argv[1]})(process.argv[2],process.argv[3])
      .then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>{process.stderr.write(e.message);process.exitCode=1});`;
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ['-e', script, f.source, f.parent, alias], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, CLAUDE_CONFIG_DIR: f.root },
  });
  const id = JSON.parse(stdout).sessionId;
  const copied: any[] = (await fs.readFile(path.join(f.root, 'projects', await projectFolder(alias), `${id}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const prompts = copied.filter((r) => ['user', 'assistant'].includes(r.type));
  assert.equal(prompts.length, 2);
  assert.notEqual(prompts[0].uuid, first);
  assert.notEqual(prompts[1].uuid, second);
  assert.equal(prompts[1].parentUuid, prompts[0].uuid);
  assert.ok(prompts.every((r) => r.sessionId === id && r.cwd === alias));
  assert.ok(copied.every((r) => r.type !== 'file-history-snapshot'));
  const read = `(async()=>{const sdk=await import('@anthropic-ai/claude-agent-sdk');
    const rows=await sdk.getSessionMessages(process.argv[1],{dir:process.argv[2]});process.stdout.write(JSON.stringify(rows));})();`;
  const child = await run(process.execPath, ['-e', read, id, alias], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, CLAUDE_CONFIG_DIR: f.root },
  });
  assert.equal(JSON.parse(child.stdout).length, 2);
});

test('project directory keys follow the SDK path normalization on macOS and other hosts', async () => {
  const io = { realpath: async () => '/cafe\u0301' };
  assert.equal(await projectFolder('/alias', io, 'darwin'), '-caf-');
  assert.equal(await projectFolder('/alias', io, 'linux'), '-cafe-');
});

const agentRows = [
  {
    type: 'assistant',
    message: { content: [null, { type: 'tool_use', name: 'Agent', id: 'call' }, { type: 'tool_use', name: 'Bash', id: 'shell' }] },
  },
  {
    type: 'user',
    toolUseResult: { agentId: 'kept' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'agentId: from-text' }] },
  },
  { type: 'user', toolUseResult: { agentId: '../bad' }, message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 3 }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] } },
  { type: 'user', toolUseResult: { agentId: 3 }, message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] } },
  {
    type: 'user',
    toolUseResult: { agentId: 'unrelated' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'shell', content: 'agentId: unrelated' }] },
  },
  { type: 'user', message: { content: 'agentId: unrelated' } },
  { type: 'summary' },
];

test('only referenced legacy flat agent files are copied, with modern history preferred and unrelated parent history excluded', async (t) => {
  const f = await fixture(t);
  const text = agentRows.map((row) => JSON.stringify(row)).join('\n');
  assert.deepEqual(referencedAgents(text), ['kept', 'from-text']);
  assert.deepEqual(referencedAgents(''), []);
  await fs.writeFile(path.join(f.project, 'agent-kept.jsonl'), 'legacy kept');
  await fs.writeFile(path.join(f.project, 'agent-unrelated.jsonl'), 'other parent');
  const make = (io: any = fs) =>
    createLinkedClaudeFork({
      findTranscript: async () => f.source,
      io,
      sdk: async () => ({ forkSession: async () => (await fs.writeFile(f.originalCopy, text), { sessionId: f.id }) }),
    });
  await make()(f.parent, '/legacy');
  const target = path.join(f.root, 'projects', '-legacy', f.id, 'subagents');
  assert.equal(await fs.readFile(path.join(target, 'agent-kept.jsonl'), 'utf8'), 'legacy kept');
  await assert.rejects(fs.stat(path.join(target, 'agent-unrelated.jsonl')), { code: 'ENOENT' });
  const modern = path.join(f.project, f.parent, 'subagents');
  await fs.mkdir(modern, { recursive: true });
  await fs.writeFile(path.join(modern, 'agent-kept.jsonl'), 'modern kept');
  await make()(f.parent, '/modern');
  assert.equal(await fs.readFile(path.join(f.root, 'projects', '-modern', f.id, 'subagents', 'agent-kept.jsonl'), 'utf8'), 'modern kept');
  await assert.rejects(
    make({
      ...fs,
      copyFile: async () => {
        throw new Error('legacy copy failed');
      },
    })(f.parent, '/copy-failure'),
    /legacy copy failed/,
  );
  await assert.rejects(
    make({
      ...fs,
      stat: async (file: string) => {
        if (file.endsWith('agent-kept.jsonl')) throw Object.assign(new Error('legacy denied'), { code: 'EACCES' });
        return fs.stat(file);
      },
    })(f.parent, '/stat-failure'),
    /legacy denied/,
  );
});
