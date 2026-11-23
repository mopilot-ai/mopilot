// A stand-in for the `codex` CLI on a Host: `codex login status` exits as FAKE_CODEX_LOGIN says, and `codex app-server` speaks the JSON-RPC lines the adapter reads. While `<FAKE_CODEX_LOG>.refuse` exists, `turn/start` is answered with an error. A turn's text picks what it does: "slow" runs a command until interrupted, "approve" asks to run one and waits for the answer, "crash" quits the process, "slowlate" is "slow" whose run begins 2.3 s after the turn started (an earlier interrupt is refused: no active turn to interrupt), anything else answers "codex: <text>". FAKE_CODEX_LOG gets one line per request received.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const log = (/** @type {object} */ o) =>
  process.env.FAKE_CODEX_LOG && fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ pid: process.pid, ...o })}\n`);

// FAKE_STAY: a child that does not leave when its parent goes (stdin closing), as a stuck agent or a command it started does not
if (process.env.FAKE_STAY) setInterval(() => undefined, 1_000_000);

if (process.argv[2] === 'login') process.exit(process.env.FAKE_CODEX_LOGIN === 'out' ? 1 : 0);

const write = (/** @type {object} */ o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const note = (/** @type {string} */ method, /** @type {object} */ params) => write({ method, params });
let threads = 0;
/** Threads this process started or resumed: loaded, so a resume needs no rollout. @type {Set<string>} */
const loaded = new Set();
const folders = new Map();
// Opt-in native history records the actual turn/start inputs; existing fixture modes retain their old protocol.
const keptInputs = new Map();
/** Turns waiting to be interrupted: thread id -> turn id. @type {Map<string, string>} */
const slow = new Map();
/** Threads whose turn exists but is not active yet ("slowlate"). @type {Set<string>} */
const late = new Set();
/** Requests the server made and waits on: request id -> what to do with the answer. @type {Map<number, (r: any) => void>} */
const asked = new Map();
let askId = 100;
/** Each thread's goal, as `thread/goal/set` made it: thread id -> goal. @type {Map<string, any>} */
const goals = new Map();

const thread = (/** @type {string} */ id, /** @type {string} */ cwd) => ({ id, cwd, preview: '', name: null, ephemeral: false, turns: [] });

function runTurn(/** @type {string} */ threadId, /** @type {string} */ text) {
  // Native submission/turn ids are UUIDs; restarting app-server must not reuse a completed turn identity.
  const id = randomUUID();
  const started = { id, status: 'inProgress', items: [], error: null };
  note('turn/started', { threadId, turn: started });
  const end = (/** @type {string} */ status, /** @type {any} */ error = null) =>
    note('turn/completed', { threadId, turn: { ...started, status, error } });
  const say = (/** @type {string} */ words) => {
    note('item/agentMessage/delta', { threadId, turnId: id, itemId: `msg-${id}`, delta: words });
    note('item/completed', { threadId, turnId: id, item: { type: 'agentMessage', id: `msg-${id}`, text: words, phase: 'final_answer' } });
  };
  if (text.includes('tools')) {
    const item = (/** @type {object} */ i) => ({ threadId, turnId: id, item: i });
    const update = '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';
    note('item/reasoning/summaryTextDelta', { threadId, turnId: id, itemId: 'rs-1', summaryIndex: 0, delta: 'thinking' });
    note('item/completed', item({ type: 'reasoning', id: 'rs-1', summary: ['thinking'], content: [] }));
    note('item/started', item({ type: 'commandExecution', id: 'cmd-1', command: 'ls -l', cwd: '/work', status: 'inProgress' }));
    note('item/commandExecution/outputDelta', { threadId, turnId: id, itemId: 'cmd-1', delta: 'total 0\n' });
    note(
      'item/completed',
      item({
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'ls -l',
        cwd: '/work',
        status: 'completed',
        aggregatedOutput: 'total 0\n',
        exitCode: 0,
      }),
    );
    note('turn/plan/updated', {
      threadId,
      turnId: id,
      explanation: null,
      plan: [
        { step: 'look', status: 'completed' },
        { step: 'edit', status: 'inProgress' },
        { step: 'ship', status: 'pending' },
      ],
    });
    const changes = [
      { path: '/work/b.txt', kind: { type: 'update' }, diff: update },
      { path: '/work/a.txt', kind: { type: 'add' }, diff: 'hello\n' },
    ];
    note('item/started', item({ type: 'fileChange', id: 'fc-1', changes, status: 'inProgress' }));
    note('item/completed', item({ type: 'fileChange', id: 'fc-1', changes, status: 'completed' }));
    note(
      'item/completed',
      item({
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'sage',
        tool: 'echo',
        arguments: { a: 1 },
        status: 'completed',
        result: { content: [{ type: 'text', text: 'echoed' }] },
      }),
    );
    note('item/started', item({ type: 'webSearch', id: 'ws-1', query: 'weather', status: 'inProgress' }));
    note('item/completed', item({ type: 'webSearch', id: 'ws-1', query: 'weather', status: 'completed' }));
    note('error', { threadId, turnId: id, error: { message: 'rate limited' }, willRetry: true });
    note('thread/tokenUsage/updated', {
      threadId,
      turnId: id,
      tokenUsage: { total: { totalTokens: 900 }, last: { totalTokens: 42 }, modelContextWindow: 1000 },
    });
    note('thread/name/updated', { threadId, threadName: 'not a thing a chat draws' });
    setTimeout(() => {
      say('done');
      end('completed');
    }, 10);
    return id;
  }
  if (text.includes('crash')) return setTimeout(() => process.exit(3), 20), id;
  // "slowlate", as the real app-server was seen to run it: the turn has its id (turn/started went out) but is not active until its model run begins 2.3 s later; a turn/interrupt before that is refused with "no active turn to interrupt"
  if (text.includes('slowlate')) {
    late.add(threadId);
    setTimeout(() => {
      late.delete(threadId);
      note('item/started', {
        threadId,
        turnId: id,
        item: { type: 'commandExecution', id: `cmd-${id}`, command: 'sleep 100', status: 'inProgress' },
      });
      slow.set(threadId, id);
    }, 2300);
    return id;
  }
  if (text.includes('slow')) {
    note('item/started', {
      threadId,
      turnId: id,
      item: { type: 'commandExecution', id: `cmd-${id}`, command: 'sleep 100', status: 'inProgress' },
    });
    slow.set(threadId, id);
    return id;
  }
  if (text.includes('approve')) {
    const rid = askId++;
    asked.set(rid, (answer) => {
      say(`ran: ${answer?.decision}`);
      end('completed');
    });
    write({
      id: rid,
      method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId: id, itemId: 'c1', command: 'rm -rf build' },
    });
    return id;
  }
  // "askfiles": a multi-choice question the person answers (its answers go in the reply, so a spec can see what the agent got)
  if (text.includes('askfiles')) {
    const rid = askId++;
    asked.set(rid, (answer) => {
      say(`files: ${JSON.stringify(answer?.answers ?? null)}`);
      end('completed');
    });
    write({
      id: rid,
      method: 'item/tool/requestUserInput',
      params: {
        threadId,
        turnId: id,
        questions: [
          {
            id: 'files',
            header: 'Files',
            question: 'Which files?',
            multiSelect: true,
            options: [
              { label: 'a.ts', description: '' },
              { label: 'b.ts', description: '' },
            ],
          },
        ],
      },
    });
    return id;
  }
  if (text.includes('input')) {
    const rid = askId++;
    asked.set(rid, (answer) => {
      say(`input: ${answer?.error ? 'refused' : 'given'}`);
      end('completed');
    });
    write({ id: rid, method: 'item/tool/requestUserInput', params: { threadId, turnId: id, questions: [] } });
    return id;
  }
  setTimeout(() => {
    say('codex: ');
    say(text);
    end('completed');
  }, 10);
  return id;
}

/**
 * With FAKE_CODEX_HOME set, a turn records its prompt in the thread's rollout file as Codex does
 * (`sessions/<y>/<m>/<d>/rollout-<time>-<thread>.jsonl`), and `thread/delete` answers as FAKE_CODEX_DELETE says: `remove` (default)
 * removes the file, `archive` only moves it to `archived_sessions` (what `thread/archive` does), `leave` answers and keeps it, `fail` refuses.
 * A thread the server holds no rollout for is "no rollout found", as Codex answers for a thread with no turn.
 */
/** @type {Map<string, string>} thread id -> rollout file */
const rollouts = new Map();
function recordRollout(/** @type {string} */ threadId, /** @type {string} */ text) {
  const home = process.env.FAKE_CODEX_HOME;
  if (!home) return;
  let file = rollouts.get(threadId);
  if (!file) {
    const dir = `${home}/sessions/2026/11/18`;
    fs.mkdirSync(dir, { recursive: true });
    file = `${dir}/rollout-2026-11-18T00-00-00-${threadId}.jsonl`;
    rollouts.set(threadId, file);
  }
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user_message', message: text })}\n`);
}
function deleteThread(/** @type {string} */ threadId) {
  const mode = process.env.FAKE_CODEX_DELETE ?? 'remove';
  const file = rollouts.get(threadId);
  if (mode === 'fail') return { __error: 'database is locked' };
  if (!file) return { __error: `no rollout found for thread id ${threadId}` };
  if (mode === 'remove') fs.rmSync(file, { force: true });
  if (mode === 'archive') {
    fs.mkdirSync(`${process.env.FAKE_CODEX_HOME}/archived_sessions`, { recursive: true });
    fs.renameSync(file, `${process.env.FAKE_CODEX_HOME}/archived_sessions/${file.split('/').pop()}`);
  }
  if (mode !== 'leave') rollouts.delete(threadId);
  return {};
}

const handlers = {
  'thread/delete': (/** @type {any} */ p) => deleteThread(p.threadId),
  initialize: () => ({ userAgent: 'fake-codex', codexHome: '/h' }),
  'config/read': () => ({ config: {} }),
  'model/list': () => ({
    data: [
      {
        id: 'm1',
        model: 'gpt-fake',
        displayName: 'GPT Fake',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      },
      { id: 'm2', model: 'gpt-other', displayName: 'GPT Other', isDefault: false, supportedReasoningEfforts: [] },
    ],
  }),
  // the skills Codex lists for the folders asked about (`skills/list`): one of the project's, one the user has switched off
  'skills/list': (/** @type {any} */ p) => ({
    data: (p.cwds ?? []).map((/** @type {string} */ cwd) => ({
      cwd,
      skills: [
        {
          name: 'fake-codex-skill',
          description: 'A Codex skill the fake knows',
          shortDescription: 'A skill the fake knows',
          scope: 'repo',
          path: `${cwd}/.codex/skills/fake-codex-skill`,
          enabled: true,
        },
        { name: 'fake-codex-off', description: 'A skill that is switched off', scope: 'user', path: '/u/off', enabled: false },
      ],
      errors: [],
    })),
  }),
  // FAKE_CODEX_UUIDS: thread ids as Codex's are (UUIDs), for what looks a thread up by its shape
  'thread/start': (/** @type {any} */ p) => {
    const made = thread(process.env.FAKE_CODEX_UUIDS ? randomUUID() : `th-${process.pid}-${++threads}`, p.cwd);
    loaded.add(made.id);
    folders.set(made.id, made.cwd);
    return { thread: made };
  },
  'thread/fork': (/** @type {any} */ p) => {
    // The native-fork scenarios opt in. Other fixtures use an unavailable fork to exercise their fallback.
    if (process.env.FAKE_CODEX_FORKS !== '1') return {};
    if (!loaded.has(p.threadId)) return { __error: 'No source thread' };
    const id = process.env.FAKE_CODEX_UUIDS ? randomUUID() : `th-${process.pid}-${++threads}`;
    const made = { ...thread(id, folders.get(p.threadId) ?? '/work'), ephemeral: p.ephemeral === true };
    loaded.add(id);
    folders.set(id, made.cwd);
    return { thread: made };
  },
  'thread/resume': (/** @type {any} */ p) => {
    // FAKE_CODEX_STRICT_RESUME=<file>: as the real app-server, a thread that is not loaded here and has no rollout (no turn was ever recorded on it, in this process or an earlier one that wrote <file>) is "no rollout found"
    const strict = process.env.FAKE_CODEX_STRICT_RESUME;
    if (strict && !loaded.has(p.threadId) && !(fs.existsSync(strict) && fs.readFileSync(strict, 'utf8').split('\n').includes(p.threadId)))
      return { __error: `no rollout found for thread id ${p.threadId}` };
    loaded.add(p.threadId);
    return { thread: thread(p.threadId, '/work') };
  },
  'turn/start': (/** @type {any} */ p) => {
    // a turn the app-server refuses to start (as it does for a model the account cannot use) while the file `<FAKE_CODEX_LOG>.refuse` exists
    if (process.env.FAKE_CODEX_LOG && fs.existsSync(`${process.env.FAKE_CODEX_LOG}.refuse`))
      return { __error: 'The model is not available to this account.' };
    const text = (p.input ?? []).map((/** @type {any} */ b) => b.text ?? '').join('');
    // the first message writes the rollout: the thread outlives this process from here
    if (process.env.FAKE_CODEX_STRICT_RESUME) fs.appendFileSync(process.env.FAKE_CODEX_STRICT_RESUME, `${p.threadId}\n`);
    recordRollout(p.threadId, text);
    const id = runTurn(p.threadId, text);
    if (process.env.FAKE_CODEX_KEEP_INPUTS) {
      const records = keptInputs.get(p.threadId) ?? [];
      records.push({
        id,
        status: 'completed',
        error: null,
        items: [{ type: 'userMessage', id: `native-${id}`, clientId: p.clientUserMessageId ?? null, content: p.input }],
      });
      keptInputs.set(p.threadId, records);
    }
    return { turn: { id, status: 'inProgress', items: [], error: null } };
  },
  'thread/turns/list': (p) =>
    process.env.FAKE_CODEX_KEEP_INPUTS ? { data: [...(keptInputs.get(p.threadId) ?? [])].reverse(), nextCursor: null } : {},
  'thread/goal/get': (/** @type {any} */ p) => ({ goal: goals.get(p.threadId) ?? null }),
  // as the app-server does: the goal keeps what the request does not name, tells every client (`thread/goal/updated`), and an active goal that was not running starts a turn of its own on the objective (no user message)
  'thread/goal/set': (/** @type {any} */ p) => {
    const prev = goals.get(p.threadId);
    const at = Math.floor(Date.now() / 1000);
    const goal = {
      threadId: p.threadId,
      objective: p.objective ?? prev?.objective ?? '',
      status: p.status ?? prev?.status ?? 'active',
      tokenBudget: p.tokenBudget !== undefined ? p.tokenBudget : (prev?.tokenBudget ?? null),
      tokensUsed: prev?.tokensUsed ?? 0,
      timeUsedSeconds: prev?.timeUsedSeconds ?? 0,
      createdAt: prev?.createdAt ?? at,
      updatedAt: at,
    };
    goals.set(p.threadId, goal);
    setImmediate(() => {
      note('thread/goal/updated', { threadId: p.threadId, turnId: slow.get(p.threadId) ?? null, goal });
      // an objective with "slow" in any case keeps its turn running until it is interrupted
      if (goal.status === 'active' && prev?.status !== 'active' && !slow.has(p.threadId))
        runTurn(p.threadId, /slow/i.test(goal.objective) ? 'slow' : goal.objective);
    });
    return { goal };
  },
  'thread/goal/clear': (/** @type {any} */ p) => {
    const cleared = goals.delete(p.threadId);
    if (cleared) setImmediate(() => note('thread/goal/cleared', { threadId: p.threadId }));
    return { cleared };
  },
  'turn/interrupt': (/** @type {any} */ p) => {
    if (late.has(p.threadId)) return { __error: 'no active turn to interrupt' };
    const id = slow.get(p.threadId);
    slow.delete(p.threadId);
    if (id)
      setTimeout(() => note('turn/completed', { threadId: p.threadId, turn: { id, status: 'interrupted', items: [], error: null } }), 5);
    return {};
  },
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  log({ method: msg.method, id: msg.id, params: msg.params, result: msg.result, error: msg.error });
  if (msg.method === undefined && asked.has(msg.id)) return asked.get(msg.id)?.(msg.result ?? { error: msg.error }), asked.delete(msg.id);
  if (msg.id === undefined) return;
  const h = /** @type {Record<string, (p: any) => any>} */ (handlers)[msg.method];
  const out = h ? h(msg.params ?? {}) : {};
  write(out?.__error ? { id: msg.id, error: { code: -32600, message: out.__error } } : { id: msg.id, result: out });
});
