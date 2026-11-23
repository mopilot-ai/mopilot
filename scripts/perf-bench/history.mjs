// Generated histories for the benchmarks: long chats in each harness's own on-disk format for the open-a-chat benchmark (user text, tool calls, a reply of 8-20 kB, a marker at the end), and sized transcripts, rollouts and path listings for the read-path benchmark.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** About `bytes` of a Claude Code chat as `getSessionMessages` reads it: prompts, tool calls with their results, and replies. */
export function claudeMessages(/** @type {number} */ bytes) {
  const messages = [];
  let size = 0;
  for (let turn = 0; size < bytes; turn++) {
    const prompt = {
      type: 'user',
      uuid: `p${turn}`,
      timestamp: new Date(1_700_000_000_000 + turn * 60_000).toISOString(),
      message: { role: 'user', content: `prompt ${turn}` },
    };
    const call = (tool) => ({
      type: 'assistant',
      uuid: `c${turn}-${tool}`,
      message: {
        id: `m${turn}-${tool}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${turn}-${tool}`, name: 'Bash', input: { command: 'npm test' } }],
      },
    });
    const result = (tool) => ({
      type: 'user',
      uuid: `r${turn}-${tool}`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${turn}-${tool}`, content: shapedText('code', 2048) }] },
    });
    const reply = {
      type: 'assistant',
      uuid: `a${turn}`,
      message: { id: `m${turn}`, role: 'assistant', content: [{ type: 'text', text: shapedText('prose', 4096) }] },
    };
    const said = [prompt, call(0), result(0), call(1), result(1), reply];
    messages.push(...said);
    size += JSON.stringify(said).length;
  }
  return messages;
}

/** A reply of about `bytes` characters, ending in `marker` so a test can tell the last turn has been drawn. */
export function replyText(/** @type {number} */ bytes, /** @type {string} */ marker) {
  return `${shapedText('prose', bytes)} ${marker}`;
}

/** The turns of one chat: sizes cycle through 8-20 kB, every third turn runs `tools` commands first. */
export function turnSpecs(/** @type {string} */ tag, /** @type {number} */ count, tools = 3) {
  return Array.from({ length: count }, (_, i) => ({
    text: `Q-${tag}-${i}: please look at module ${i} and explain what it does`,
    reply: replyText(8192 + ((i * 3571) % 12288), i === count - 1 ? `END-${tag}` : `R-${tag}-${i}`),
    tools: i % 3 === 0 ? tools : 0,
  }));
}

/** Codex: the fake app-server's FAKE_CODEX_THREADS entries (tests/e2e/fixtures/fake-codex.mjs), each turn with its items made. */
export function codexThreads(/** @type {string[]} */ tags, /** @type {number[]} */ sizes) {
  return tags.map((tag, n) => ({
    id: `perf-codex-${tag}`,
    name: `perf codex ${tag}`,
    turns: turnSpecs(tag, sizes[n % sizes.length]).map((spec) => ({
      text: spec.text,
      items: [
        { type: 'userMessage', id: randomUUID(), clientId: null, content: [{ type: 'text', text: spec.text, text_elements: [] }] },
        ...Array.from({ length: spec.tools }, (_, i) => ({
          type: 'commandExecution',
          id: randomUUID(),
          command: `ls -la src/part-${i}`,
          cwd: '/',
          processId: null,
          source: 'agent',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'x'.repeat(400),
          exitCode: 0,
          durationMs: 5,
        })),
        { type: 'agentMessage', id: randomUUID(), text: spec.reply, phase: null, memoryCitation: null, delivery: null, questions: null },
      ],
    })),
  }));
}

/** Claude Code: a finished transcript the SDK reads, with tool_use/tool_result pairs. */
export function writeClaudeSession(
  /** @type {string} */ claudeHome,
  /** @type {string} */ home,
  /** @type {{ id: string, tag: string, turns: number }} */ s,
) {
  const cwd = path.join(home, 'perf-claude');
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  /** @type {string | null} */
  let parentUuid = null;
  let t = Date.now() - 3_600_000;
  const lines = [];
  const add = (/** @type {string} */ type, /** @type {object} */ extra) => {
    const uuid = randomUUID();
    lines.push(
      JSON.stringify({
        parentUuid,
        isSidechain: false,
        userType: 'external',
        cwd,
        sessionId: s.id,
        version: '9.9.9',
        gitBranch: '',
        type,
        uuid,
        timestamp: new Date((t += 1000)).toISOString(),
        ...extra,
      }),
    );
    parentUuid = uuid;
  };
  const assistant = (/** @type {object[]} */ content, /** @type {string} */ stop) =>
    add('assistant', {
      message: {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content,
        stop_reason: stop,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  for (const [i, spec] of turnSpecs(s.tag, s.turns).entries()) {
    add('user', { message: { role: 'user', content: spec.text } });
    for (let n = 0; n < spec.tools; n++) {
      const toolId = `toolu_${randomUUID().slice(0, 12)}`;
      assistant([{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: `ls -la src/part-${n}` } }], 'tool_use');
      add('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'x'.repeat(400) }] } });
    }
    assistant([{ type: 'text', text: spec.reply }], 'end_turn');
    if (i === 0) lines.push(JSON.stringify({ type: 'custom-title', customTitle: `perf claude ${s.tag}`, sessionId: s.id }));
  }
  fs.writeFileSync(path.join(dir, `${s.id}.jsonl`), lines.join('\n') + '\n');
}

/** Reply text by what it costs a parser: plain ASCII, mostly escapes, or multi-byte. */
const TEXT_SHAPES = {
  prose: 'The handler reads the config, validates each field and returns early when the cache is warm. ',
  code: 'if (name.endsWith("\\\\")) {\n\tout.push(`"${name}": ${JSON.stringify(value)}`);\n}\n',
  cjk: '处理程序读取配置，校验每个字段，并在缓存命中时提前返回。',
};
export const TRANSCRIPT_SHAPES = /** @type {(keyof typeof TEXT_SHAPES)[]} */ (Object.keys(TEXT_SHAPES));

/** `length` characters of a shape's text. */
export function shapedText(/** @type {keyof typeof TEXT_SHAPES} */ shape, /** @type {number} */ length) {
  const piece = TEXT_SHAPES[shape];
  return piece.repeat(Math.ceil(length / piece.length)).slice(0, length);
}

/** One JSON record a line, up to at least `bytes` of UTF-8: `next(add, i)` adds a turn's records until there is enough. */
function jsonLines(
  /** @type {number} */ bytes,
  /** @type {object[]} */ first,
  /** @type {(add: (r: object) => void, i: number) => void} */ next,
) {
  const lines = [];
  let size = 0;
  const add = (/** @type {object} */ record) => {
    const line = JSON.stringify(record);
    lines.push(line);
    size += Buffer.byteLength(line) + 1;
  };
  first.forEach(add);
  for (let i = 0; size < bytes; i++) next(add, i);
  return `${lines.join('\n')}\n`;
}

/** A basic chat's threads/<id>.items.jsonl of at least `bytes`, each turn a command and eight streamed pieces of a shape's text. */
export function acpTranscript(
  /** @type {string} */ tag,
  /** @type {number} */ bytes,
  /** @type {keyof typeof TEXT_SHAPES} */ shape = 'prose',
  chunk = 512,
) {
  const text = shapedText(shape, chunk);
  return jsonLines(bytes, [{ t: 'session', cwd: '/perf', sessionId: `perf-${tag}`, at: 1 }], (add, i) => {
    const turnId = `at-${tag}-${i}`;
    const toolCallId = `call_${tag}_${i}`;
    const content = [{ type: 'text', text: `Q-${tag}-${i}: please look at module ${i}`, text_elements: [] }];
    add({ t: 'user', turnId, user: { id: `u-${tag}-${i}`, clientId: `${tag}-${i}`, content }, at: i + 2 });
    add({
      t: 'update',
      turnId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'ls -la',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'ls -la' },
      },
    });
    add({
      t: 'update',
      turnId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text } }],
      },
    });
    for (let n = 0; n < 8; n++)
      add({ t: 'update', turnId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
    add({ t: 'end', turnId, stopReason: 'end_turn', error: null });
  });
}

/** A Codex rollout file's text of at least `bytes`: each turn's events, with the model's own records most of the file as in a real one. */
export function codexRollout(
  /** @type {string} */ tag,
  /** @type {number} */ bytes,
  /** @type {keyof typeof TEXT_SHAPES} */ shape = 'prose',
) {
  const text = shapedText(shape, 512);
  const event = (/** @type {object} */ payload) => ({ type: 'event_msg', payload });
  return jsonLines(bytes, [{ type: 'session_meta', payload: { cwd: '/perf' } }], (add, i) => {
    const turn_id = `turn-${tag}-${i}`;
    add(event({ type: 'task_started', turn_id }));
    add(event({ type: 'user_message', turn_id, message: `Q-${tag}-${i}: please look at module ${i}` }));
    for (let n = 0; n < 6; n++) add({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text }] } });
    add(event({ type: 'agent_message', turn_id, message: text }));
    add(event({ type: 'task_complete', turn_id }));
  });
}

/** `count` distinct file paths shaped like a large repository's listing. */
export function pathListing(/** @type {number} */ count) {
  const areas = ['src/components', 'electron/platform', 'tests/fixtures', 'node_modules/.cache', 'docs/architecture'];
  return Array.from({ length: count }, (_, i) => `${areas[i % areas.length]}/panel-${i % 97}/widgets/file-${i}.tsx`);
}

/** Basic harness: records appended to a chat's threads/<id>.items.jsonl as the harness writes them (text in `chunk`-character pieces). */
export function acpRecords(/** @type {string} */ tag, /** @type {number} */ count, chunk = 512) {
  const out = [];
  let at = Date.now() - 3_600_000;
  for (const [i, spec] of turnSpecs(tag, count).entries()) {
    const turnId = `at-${tag}-${i}`;
    out.push({
      t: 'user',
      turnId,
      user: { id: `u-${tag}-${i}`, clientId: `${tag}-${i}`, content: [{ type: 'text', text: spec.text, text_elements: [] }] },
      at: (at += 1000),
    });
    for (let n = 0; n < spec.tools; n++) {
      const toolCallId = `call_${tag}_${i}_${n}`;
      const command = `ls -la src/part-${n}`;
      out.push({
        t: 'update',
        turnId,
        update: { sessionUpdate: 'tool_call', toolCallId, title: command, kind: 'execute', status: 'pending', rawInput: { command } },
        at: (at += 10),
      });
      out.push({
        t: 'update',
        turnId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(400) } }],
        },
        at: (at += 10),
      });
    }
    for (let p = 0; p < spec.reply.length; p += chunk)
      out.push({
        t: 'update',
        turnId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: spec.reply.slice(p, p + chunk) } },
        at: (at += 5),
      });
    out.push({ t: 'end', turnId, stopReason: 'end_turn', error: null, at: (at += 10) });
  }
  return out;
}
