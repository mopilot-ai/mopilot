// A stand-in for the Claude Agent SDK's `query()`: the harness runs for real (electron/harness/claude) and this plays the CLI. A message's text picks what the "CLI" does: SLOW streams and then waits for an interrupt, TOOL asks the permission callback before it answers, CRASH throws out of the stream, anything else is echoed. A session writes its transcript file the way the CLI does, so a later process can resume it.
import fs from 'node:fs';
import path from 'node:path';

/** The fields the CLI puts on every record it writes. */
const cli0 = (cwd) => ({ isSidechain: false, userType: 'external', cwd, version: '9.9.9', gitBranch: '' });

const textOf = (message) =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

/** @param {{ configDir: string, cli?: string, recordInputs?: boolean, recordReplies?: boolean }} o `recordReplies`: the transcript also keeps each turn's reply (what a switch reads the conversation from); `cli`: a script the fake starts through the harness's spawn option, as the SDK starts the CLI (it is the process a Host that dies leaves behind) */
export function createFakeClaudeSdk({ configDir, cli, recordInputs = false, recordReplies = false }) {
  /** Every query the harness started. */
  const queries = [];
  let seq = 0;

  class FakeQuery {
    constructor(prompt, options) {
      this.prompt = prompt;
      this.options = options;
      this.sessionId = options.sessionId ?? options.resume;
      this.interrupted = false;
      this.closed = false;
      this.ended = false;
      this.messages = [];
      this.asked = [];
      this.wakes = [];
      /** The live controls the harness applied: [method, argument]. */
      this.controls = [];
    }
    async interrupt() {
      this.interrupted = true;
      for (const wake of this.wakes.splice(0)) wake();
    }
    close() {
      this.closed = true;
      this.prompt.close?.();
      for (const wake of this.wakes.splice(0)) wake();
    }
    async getSettings() {
      return { applied: {} };
    }
    async generateSessionTitle() {
      return 'A fake title';
    }
    async setModel(model) {
      this.controls.push(['setModel', model]);
    }
    async setPermissionMode(mode) {
      this.controls.push(['setPermissionMode', mode]);
    }
    async applyFlagSettings(settings) {
      this.controls.push(['applyFlagSettings', settings]);
    }
    /** What a model probe reads (no prompt is sent). */
    async initializationResult() {
      if (fake.probeError) throw new Error(fake.probeError);
      return { models: fake.models, account: {}, fast_mode_disabled_reason: null };
    }
    /** Waits until the harness interrupts or closes this query. */
    stopped() {
      return this.interrupted || this.closed ? Promise.resolve() : new Promise((resolve) => this.wakes.push(resolve));
    }
    async *[Symbol.asyncIterator]() {
      // the CLI writes the session's file when it starts (a resume finds it already)
      const file = path.join(configDir, 'projects', 'fake-project', `${this.sessionId}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file))
        fs.writeFileSync(file, `${JSON.stringify({ type: 'system', cwd: this.options.cwd, sessionId: this.sessionId })}\n`);
      if (cli && this.options.spawnClaudeCodeProcess)
        this.cli = this.options.spawnClaudeCodeProcess({
          command: process.execPath,
          args: [cli],
          env: process.env,
          cwd: this.options.cwd,
          signal: new AbortController().signal,
        });
      yield this.frame({
        type: 'system',
        subtype: 'init',
        permissionMode: this.options.permissionMode ?? 'default',
        tools: [],
        slash_commands: [],
        skills: [],
        agents: [],
        model: 'fake',
      });
      /** @type {string | null} */
      let parent = null;
      try {
        for await (const input of this.prompt) {
          const text = textOf(input.message);
          this.messages.push(input.message);
          // the CLI links each record to the one before it, and a reader walks that chain
          const chain = recordReplies ? { parentUuid: parent, ...cli0(this.options.cwd) } : {};
          if (recordInputs)
            fs.appendFileSync(
              file,
              `${JSON.stringify({ type: 'user', uuid: input.uuid, ...chain, sessionId: this.sessionId, timestamp: new Date().toISOString(), message: input.message })}\n`,
            );
          if (recordReplies) {
            parent = `a-${input.uuid}`;
            fs.appendFileSync(
              file,
              `${JSON.stringify({ type: 'assistant', uuid: parent, parentUuid: input.uuid, ...cli0(this.options.cwd), sessionId: this.sessionId, timestamp: new Date().toISOString(), message: { id: `msg-${input.uuid}`, type: 'message', model: 'fake', role: 'assistant', content: [{ type: 'text', text: `fake-claude: ${text}` }], stop_reason: 'end_turn' } })}\n`,
            );
          }
          yield* this.turn(text);
        }
      } finally {
        this.ended = true;
        this.cli?.kill('SIGKILL');
      }
    }
    frame(m) {
      return { session_id: this.sessionId, uuid: `u${++seq}`, parent_tool_use_id: null, ...m };
    }
    delta(text) {
      return this.frame({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    }
    assistant(id, text, usage) {
      return this.frame({
        type: 'assistant',
        message: { id, role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', ...(usage ? { usage } : {}) },
      });
    }
    result(text, extra = {}) {
      return this.frame({ type: 'result', subtype: 'success', is_error: false, result: text, ...extra });
    }
    async *turn(text) {
      const id = `msg_${++seq}`;
      if (text.includes('CRASH')) {
        // mid-turn, not at once: the message has reached the CLI
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('the CLI died');
      }
      if (text.includes('SILENT')) {
        // an assistant message that was not streamed arrives whole
        yield this.assistant(id, `whole: ${text}`);
        yield this.result(text);
        return;
      }
      yield this.frame({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
      if (text.includes('SLOW')) {
        yield this.delta('working');
        await this.stopped();
        yield this.result('stopped', { subtype: 'error_during_execution', is_error: true });
        return;
      }
      if (text.includes('TOOLS')) {
        // a turn with thinking, tool calls (one failing), the todo list, a sub-agent and its own call, then an answer
        yield this.frame({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me look' } },
        });
        const calls = [
          { type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'ls', description: 'List files' } },
          { type: 'tool_use', id: 'tu-todo', name: 'TodoWrite', input: { todos: [{ content: 'look', status: 'in_progress' }] } },
          { type: 'tool_use', id: 'tu-edit', name: 'Edit', input: { file_path: '/repo/a.txt', old_string: 'a', new_string: 'b' } },
          { type: 'tool_use', id: 'tu-task', name: 'Task', input: { description: 'dig', subagent_type: 'general-purpose' } },
        ];
        yield this.frame({
          type: 'assistant',
          message: {
            id,
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'let me look' }, ...calls],
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
          },
        });
        yield this.frame({
          type: 'assistant',
          parent_tool_use_id: 'tu-task',
          message: {
            id: `${id}-sub`,
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/repo/b.txt' } }],
          },
        });
        yield this.frame({
          type: 'user',
          parent_tool_use_id: 'tu-task',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-read', content: 'file b' }] },
        });
        yield this.frame({
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu-bash', content: [{ type: 'text', text: 'a.txt' }] },
              { type: 'tool_result', tool_use_id: 'tu-todo', content: 'Todos modified' },
              { type: 'tool_result', tool_use_id: 'tu-edit', content: 'no such file', is_error: true },
              { type: 'tool_result', tool_use_id: 'tu-task', content: 'found it' },
            ],
          },
        });
        const answer = 'done with tools';
        yield this.frame({ type: 'stream_event', event: { type: 'message_start', message: { id: `${id}-2` } } });
        yield this.delta(answer);
        yield this.assistant(`${id}-2`, answer, { input_tokens: 20, output_tokens: 6, cache_read_input_tokens: 200 });
        yield this.result(answer, {
          usage: { input_tokens: 30, output_tokens: 11, cache_read_input_tokens: 300 },
          modelUsage: { fake: { contextWindow: 1000 } },
        });
        return;
      }
      // the provider refuses the stored login for its organization (#4908): the CLI says so as a synthetic assistant message, then ends the turn in error
      if (text.includes('REFUSE-LOGIN')) {
        const said =
          'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
        yield this.frame({
          type: 'assistant',
          error: 'oauth_org_not_allowed',
          isApiErrorMessage: true,
          apiErrorStatus: 403,
          apiErrorCode: 'oauth_not_allowed_for_organization',
          message: {
            id: `${id}-r`,
            role: 'assistant',
            model: '<synthetic>',
            content: [{ type: 'text', text: said }],
            stop_reason: 'stop_sequence',
          },
        });
        yield this.result(said, { is_error: true });
        return;
      }
      if (text.includes('FAIL')) {
        yield this.result('Credit balance is too low', { is_error: true });
        return;
      }
      if (text.includes('PLANCARD')) {
        const controller = new AbortController();
        const asked = this.options.canUseTool(
          'ExitPlanMode',
          { plan: '1. Do it', planFilePath: '/plans/a.md' },
          { signal: controller.signal, toolUseID: 'tool-plan', title: 'Ready to code?' },
        );
        this.asked.push({ controller, asked });
        const verdict = await asked;
        const reply = verdict.behavior === 'allow' ? 'plan approved' : 'keep planning';
        yield this.delta(reply);
        yield this.assistant(id, reply);
        yield this.result(reply);
        return;
      }
      if (text.includes('TOOL')) {
        const controller = new AbortController();
        const asked = this.options.canUseTool(
          'Bash',
          { command: 'ls' },
          { signal: controller.signal, toolUseID: 'tool-1', title: 'Run ls' },
        );
        this.asked.push({ controller, asked });
        // a Stop aborts the call the way the CLI does
        void this.stopped().then(() => controller.abort());
        const verdict = await asked;
        const reply = verdict.behavior === 'allow' ? 'ran ls' : `refused: ${verdict.message}`;
        yield this.delta(reply);
        yield this.assistant(id, reply);
        yield this.result(reply);
        return;
      }
      const reply = `fake-claude: ${text}`;
      yield this.delta(reply.slice(0, 7));
      yield this.delta(reply.slice(7));
      yield this.assistant(id, reply);
      yield this.result(reply);
    }
  }

  const fake = {
    /** The sessions the harness started for chats (its helper queries, a model probe or a title, are not among them). */
    queries,
    /** Set to a message and the next session fails to start with it. */
    failStart: /** @type {string | null} */ (null),
    /** What a model probe finds, or the error it fails with. */
    models: [
      {
        value: 'fake-model',
        displayName: 'Fake Model',
        description: 'A model',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAutoMode: false,
      },
      { displayName: 'no id' },
    ],
    probeError: /** @type {string | null} */ (null),
    /** The number of probes asked. */
    probes: 0,
    /** What the harness imports as the Agent SDK. */
    sdk: async () => ({
      query: ({ prompt, options }) => {
        if (fake.failStart) throw new Error(fake.failStart);
        const q = new FakeQuery(prompt, options);
        if (options.canUseTool) queries.push(q);
        else fake.probes++;
        return q;
      },
      // the in-process MCP servers a session is given (electron/capabilities/mcp/sdkMcp.cjs): a test calls a tool's handler as the CLI would
      tool: (name, description, schema, handler, extras) => ({ name, description, schema, handler, extras }),
      createSdkMcpServer: (config) => ({ type: 'sdk', ...config }),
      renameSession: async () => undefined,
      getSessionInfo: async () => undefined,
      listSessions: async () => [],
      // the SDK reads a session's messages from its transcript; this fake does so only for a run that kept replies (a switch reads the conversation here)
      getSessionMessages: async (/** @type {string} */ sessionId) => {
        if (!recordReplies) return [];
        const file = path.join(configDir, 'projects', 'fake-project', `${sessionId}.jsonl`);
        if (!fs.existsSync(file)) return [];
        return fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((r) => r.type === 'user' || r.type === 'assistant')
          .map((r) => ({ type: r.type, uuid: r.uuid, session_id: sessionId, message: r.message, parent_tool_use_id: null }));
      },
    }),
  };
  return fake;
}
