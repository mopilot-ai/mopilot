#!/usr/bin/env node
// A resident fake Host for the chat specs: it keeps chats and their turns running while the app (and the fake `ssh` tunnel to it) comes and goes, as a real Host does when the Mac is closed.
// It listens on FAKE_HOST_CHATS_SOCK and speaks the line protocol for the chat methods only (chat.start, chat.send, chat.stop, chat.answer, chat.permit, chat.subscribe); the fake `ssh` bridges to it.
// A message that says "stream2" tells the second vocabulary (the chat's title and goal on the state lane, a command's live output, a sub-agent's words) the way a Host with that feature does.
// A message that says "nosignin" runs a git command that failed for a missing sign-in, with the Host's own line in its output.
// A message that says "cutoff" is cut off once the way a Host restart cuts a turn off (ended as cancelled with `interrupted`), and runs to its end when sent again.
// A message that says "approve" raises a permission card and waits for chat.answer; one that says "slow" streams until chat.stop; any other is answered with "fake-host: <text>" in two pieces.
// "report context" waits for the FAKE_HOST_CONTEXT_RELEASE file, then reports context just before ending the turn.
// Every request it answers is appended to FAKE_HOST_LOG (one JSON line) so a spec can read what the app asked.
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sock = process.env.FAKE_HOST_CHATS_SOCK;
const GENERATION = `fake-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (method, params) =>
  process.env.FAKE_HOST_LOG && fs.appendFileSync(process.env.FAKE_HOST_LOG, `${JSON.stringify({ method, params })}\n`);

/** @type {Map<string, { rev: number, seq: number, items: any[], tail: any[], subs: Set<(frame: any) => void>, inflight: Map<string, any[]>, state: Record<string, any>, turn: any, turns: number }>} */
const chats = new Map();
/** Replies kept by key: the same request again returns the first reply. */
const replies = new Map();

function chat(id) {
  let c = chats.get(id);
  if (!c)
    chats.set(id, (c = { rev: 0, seq: 0, items: [], tail: [], subs: new Set(), inflight: new Map(), state: {}, turn: null, turns: 0 }));
  return c;
}
function emit(c, frame) {
  const f = { ...frame, seq: ++c.seq };
  for (const s of c.subs) s(f);
  return f;
}
function durable(id, item, promotes) {
  const c = chat(id);
  if (promotes) c.inflight.delete(promotes);
  c.rev++;
  c.items.push(item);
  c.tail.push({ rev: c.rev, item, promotes });
  emit(c, { t: 'durable', rev: c.rev, item, ...(promotes ? { promotes } : {}) });
}
function delta(id, key, d) {
  const c = chat(id);
  c.inflight.set(key, [...(c.inflight.get(key) ?? []), d]);
  emit(c, { t: 'delta', key, delta: d });
}
function state(id, patch) {
  const c = chat(id);
  c.state = { ...c.state, ...patch };
  emit(c, { t: 'state', patch });
}
const event = (id, e) => durable(id, { t: 'event', family: 'acp', event: e });
const textUpdate = (turnId, text) => ({
  kind: 'update',
  turnId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});

async function run(id, turnId, text) {
  const c = chat(id);
  const wait = new Promise((resolve) => (c.turn = { turnId, resolve, card: null }));
  const end = (stopReason) => {
    event(id, { kind: 'turnEnd', turnId, stopReason });
    durable(id, { t: 'assistant', turnId, text: '', stopReason, error: null });
    c.turn = null;
  };
  const key = `${turnId}:agent_message_chunk:`;
  const head = { turnId, sessionUpdate: 'agent_message_chunk' };
  if (/cutoff/.test(text) && !c.cut) {
    // the Host restarted under this turn: it ends as the next Host ends it, saying what was cut off; the same message again runs to its end
    c.cut = true;
    event(id, {
      kind: 'update',
      turnId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `cmd-${turnId}`,
        title: 'sleep 45',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'sleep 45' },
      },
    });
    await sleep(300);
    const stopped = {
      kind: 'turnEnd',
      turnId,
      stopReason: 'cancelled',
      error: { message: 'The host stopped while this turn was running.' },
      interrupted: { by: 'host_restart', running: ['sleep 45'] },
    };
    event(id, stopped);
    durable(id, { t: 'assistant', turnId, text: '', stopReason: 'cancelled', error: stopped.error.message });
    c.turn = null;
    return;
  }
  if (/compact/.test(text))
    event(id, { kind: 'update', turnId, update: { sessionUpdate: 'compaction', id: `cp-${turnId}`, trigger: 'auto' } });
  if (/elicit/.test(text)) {
    // an MCP server asks the person for input through a tool: a form question (the form as the Host parses it)
    const { parseAcpForm } = await import('../../../../shared/acpForm.mjs');
    const form = parseAcpForm(
      { type: 'object', properties: { who: { type: 'string', title: 'Who' } }, required: ['who'] },
      'Who is asking?',
    );
    c.turn.card = `q-${turnId}`;
    event(id, {
      kind: 'question',
      turnId,
      question: { id: `q-${turnId}`, kind: 'question', status: 'pending', message: 'Who is asking?', toolCallId: null, form, error: null },
    });
    if ((await wait) === 'stop') return end('cancelled');
  }
  if (/stream2/.test(text)) {
    state(id, {
      title: { name: 'Stream tour', provisional: null },
      goal: { status: 'active', objective: 'finish the stream tour', createdAt: 1000, turns: 1 },
    });
    event(id, {
      kind: 'update',
      turnId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `cmd-${turnId}`,
        title: 'ls -l',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls -l' },
      },
    });
    const out = `${turnId}:out:cmd-${turnId}`;
    const live = (t) => delta(id, out, { turnId, sessionUpdate: 'tool_output_delta', toolCallId: `cmd-${turnId}`, text: t });
    live('total 0\n');
    await sleep(400);
    live('file-live.txt\n');
    // long enough for the spec to read the live output before the finished call replaces it
    await sleep(4000);
    durable(
      id,
      {
        t: 'event',
        family: 'acp',
        event: {
          kind: 'update',
          turnId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: `cmd-${turnId}`,
            status: 'completed',
            rawOutput: { output: 'total 0\nfile-live.txt\nfile-done.txt\n' },
            content: [{ type: 'content', content: { type: 'text', text: 'total 0\nfile-live.txt\nfile-done.txt\n' } }],
          },
        },
      },
      out,
    );
  }
  // "nosignin": a command whose git found no sign-in, with the line the Host's askpass writes
  if (/nosignin/.test(text)) {
    const said =
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled\nMoPilot: git has no sign-in on this machine for https://github.com. Sign in here (for example gh auth login), or do this from the Mac.\n";
    event(id, {
      kind: 'update',
      turnId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `git-${turnId}`,
        title: 'git pull',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'git pull' },
      },
    });
    durable(id, {
      t: 'event',
      family: 'acp',
      event: {
        kind: 'update',
        turnId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: `git-${turnId}`,
          status: 'failed',
          rawOutput: { output: said },
          content: [{ type: 'content', content: { type: 'text', text: said } }],
        },
      },
    });
  }
  if (/approve/.test(text)) {
    const requestId = `card-${turnId}`;
    c.turn.card = requestId;
    event(id, {
      kind: 'permission',
      requestId,
      turnId,
      toolCall: { toolCallId: `call-${turnId}`, title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    if ((await wait) === 'stop') return end('cancelled');
  }
  if (/slow/.test(text)) {
    delta(id, key, { ...head, text: 'working' });
    for (let i = 0; i < 600; i++) {
      if (!c.turn) break;
      if ((await Promise.race([wait, sleep(100).then(() => 'tick')])) === 'stop') {
        durable(id, { t: 'event', family: 'acp', event: textUpdate(turnId, 'working') }, key);
        return end('cancelled');
      }
    }
    return;
  }
  // "limit": the turn fails as a real Host says it, its error an object on the wire (host/src/turnBridge.mjs)
  if (text === 'limit') {
    const message = "You've hit your weekly limit · resets Nov 11 at 4pm (America/Los_Angeles)";
    event(id, { kind: 'turnEnd', turnId, stopReason: 'error', error: { message } });
    durable(id, { t: 'assistant', turnId, text: '', stopReason: 'error', error: message });
    c.turn = null;
    return;
  }
  // "pause-me": nobody answered, so the Host stopped the turn and says the chat is paused (U1's `attention`); a message later clears it
  if (/pause-me/.test(text)) {
    end('cancelled');
    state(id, { attention: { kind: 'paused', reason: 'approval_timeout', since: Date.now() } });
    return;
  }
  const reply = `fake-host: ${text}`;
  const mid = Math.ceil(reply.length / 2);
  delta(id, key, { ...head, text: reply.slice(0, mid) });
  await sleep(300);
  delta(id, key, { ...head, text: reply.slice(mid) });
  await sleep(300);
  const releaseContext = process.env.FAKE_HOST_CONTEXT_RELEASE;
  if (text === 'report context' && releaseContext) {
    let stopped = false;
    void wait.then(() => {
      stopped = true;
    });
    const { waitFor } = await import('../../../support/waitFor.ts');
    const released = await waitFor(() => stopped || fs.existsSync(releaseContext), 'the context report to be released', {
      timeoutMs: 60_000,
    }).catch(() => false);
    if (stopped || !released) return end('cancelled');
    event(id, { kind: 'update', turnId, update: { sessionUpdate: 'usage_update', used: 40_000, size: 1_000_000 } });
  }
  durable(id, { t: 'event', family: 'acp', event: textUpdate(turnId, reply) }, key);
  end('end_turn');
}

/** Uploads by digest: the bytes of each blob the Host holds (FAKE_HOST_FILES). */
const blobs = new Map();

/**
 * What the real Host does with a message's files (host/src/chatFiles.mjs): a private folder per message, each file or
 * folder under it by its own name, and the turn input the agent reads naming those paths (host/src/chatEffects.mjs).
 * The input is logged as `turn.input` so a spec asserts on what the agent was handed, never on what it answered.
 */
function stage(p) {
  const files = p.files ?? [];
  if (!files.length) return [];
  const root = path.join(
    process.env.FAKE_HOST_ROOT || os.tmpdir(),
    'chat-files',
    p.chatId.replace(/\W/g, '_'),
    String(p.key).replace(/\W/g, '_'),
  );
  const names = [...new Set(files.map((f) => f.name))];
  for (const f of files) {
    const to = path.join(root, String(names.indexOf(f.name)), f.name, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, blobs.get(f.id) ?? Buffer.alloc(0));
  }
  return names.map((name) => path.join(root, String(names.indexOf(name)), name));
}

function startTurn(p) {
  const c = chat(p.chatId);
  // files and folders by name, with what the Host holds of them: the reply says them, so a picture can show what arrived
  const names = [...new Set((p.files ?? []).map((f) => f.name))];
  const held = (p.files ?? []).reduce((n, f) => n + (blobs.get(f.id)?.length ?? 0), 0);
  const staged = stage(p);
  // the turn input the real Codex adapter builds from what the Host staged (electron/harness/codexParams.cjs), so this fails when that stops naming the files
  if (staged.length)
    note('turn.input', {
      chatId: p.chatId,
      input: require('../../../../electron/harness/codexParams.cjs').buildInput(
        p.text,
        staged.map((file) => ({ kind: 'file', staged: true, path: file, name: path.basename(file) })),
      ),
    });
  const seen = names.length ? ` [files: ${names.join(', ')}; ${held} bytes]` : '';
  if (c.state?.attention) state(p.chatId, { attention: null });
  const turnId = `t${++c.turns}`;
  durable(p.chatId, { t: 'user', turnId, text: p.text });
  event(p.chatId, {
    kind: 'turnStart',
    turnId,
    user: {
      id: `u-${turnId}`,
      clientId: turnId,
      content: [{ type: 'text', text: p.text, text_elements: [] }, ...names.map((name) => ({ type: 'mention', name }))],
    },
  });
  void run(p.chatId, turnId, `${p.text}${seen}`);
  return { turnId };
}

function answer(method, p, subscribe) {
  switch (method) {
    case 'chat.remove':
      chats.delete(p.chatId);
      return { result: { replayed: false, result: { removed: true } } };
    case 'chat.start':
    case 'chat.send': {
      const kept = replies.get(`${method}:${p.key}`);
      if (kept) return { result: { replayed: true, result: kept } };
      const result = startTurn(p);
      replies.set(`${method}:${p.key}`, result);
      return { result: { replayed: false, result } };
    }
    case 'chat.attach': {
      const chunk = Buffer.from(p.data, 'base64');
      const received = p.offset + chunk.length;
      blobs.set(p.imageId, Buffer.concat([blobs.get(p.imageId)?.subarray(0, p.offset) ?? Buffer.alloc(0), chunk]));
      return { result: { replayed: false, result: { imageId: p.imageId, received, done: received === p.size } } };
    }
    case 'chat.permit': {
      if (!['default', 'read-only', 'auto-review', 'full-access'].includes(p.value))
        return { error: { code: 'mode_unavailable', message: 'Mode unavailable' } };
      state(p.chatId, { permission: p.value });
      return { result: { replayed: false, result: { changed: true } } };
    }
    case 'chat.stop': {
      chat(p.chatId).turn?.resolve('stop');
      return { result: { replayed: false, result: { stopped: true } } };
    }
    case 'chat.answer': {
      const c = chat(p.chatId);
      const there = c.turn?.card === p.requestId;
      if (there) {
        event(p.chatId, { kind: 'permissionCancelled', requestId: p.requestId });
        c.turn.card = null;
        c.turn.resolve(p.optionId === 'allow' || p.form?.action === 'accept' ? 'allow' : 'stop');
      }
      return { result: { replayed: false, result: { answered: there } } };
    }
    case 'chat.subscribe': {
      const c = chat(p.chatId);
      const resume = typeof p.fromRev === 'number' && p.generation === GENERATION && p.fromRev <= c.rev;
      subscribe(c);
      return {
        frames: [
          {
            t: 'hello',
            seq: c.seq,
            rev: c.rev,
            epoch: p.epoch,
            generation: GENERATION,
            snapshot: resume ? null : { rev: c.rev, items: c.items },
            ...(Object.keys(c.state).length ? { chatState: c.state } : {}),
            inFlightEphemeral: [...c.inflight].map(([key, deltas]) => ({ key, deltas, truncated: false })),
          },
          ...(resume ? c.tail.filter((f) => f.rev > p.fromRev).map((f) => ({ t: 'durable', seq: c.seq, ...f })) : []),
        ],
        result: { subscribed: true },
      };
    }
    default:
      return { error: `Unknown method ${method}.` };
  }
}

fs.rmSync(sock, { force: true });
net
  .createServer((socket) => {
    let buffer = '';
    const say = (m) => socket.writable && socket.write(`${JSON.stringify(m)}\n`);
    const subs = new Map();
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      for (const [c, fn] of subs) c.subs.delete(fn);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const req = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        note(req.method, req.params);
        const out = answer(req.method, req.params ?? {}, (c) => {
          const fn = (frame) => say({ event: 'frame', chatId: req.params.chatId, frame });
          subs.get(c) && c.subs.delete(subs.get(c));
          subs.set(c, fn);
          c.subs.add(fn);
        });
        for (const frame of out.frames ?? []) say({ event: 'frame', chatId: req.params.chatId, frame });
        const reply = () => say({ id: req.id, ...(out.error ? { error: out.error } : { result: out.result }) });
        // FAKE_HOST_ACK_MS: the Host starts the chat at once but its answer to chat.start comes this late (a flapping link)
        if (req.method === 'chat.start' && Number(process.env.FAKE_HOST_ACK_MS)) setTimeout(reply, Number(process.env.FAKE_HOST_ACK_MS));
        else reply();
      }
    });
  })
  .listen(sock);
setInterval(() => undefined, 1 << 30);
