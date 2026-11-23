// Real-login Host probes: run-scoped MCP configuration and app-owned continuation, with every model process confined to the permitted VM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LINK } from './elicitation-server.mjs';
import { localContinuation } from './local-continuation.mjs';
import { launchdStop } from '../../shared/host/launchd.mjs';
import { expect } from '../../scripts/host-accept/steps.mjs';

const quote = (s) => `'${String(s).replaceAll("'", "'\"'\"'")}'`;

/** @param {any} ctx @param {any} io */
export async function mcpCheck(ctx, { begin, waitCard, framesOf, isReply, root }) {
  const dir = `${ctx.state.dataDir}/elicitation-${crypto.randomUUID()}`;
  const server = `${dir}/server.mjs`;
  const evidence = `${dir}/answers.json`;
  expect((await ctx.m.run(`mkdir -p ${quote(dir)}`)).code === 0, 'Cannot create MCP scratch folder.');
  try {
    // Agent SDK sessions load project .mcp.json without an interactive approval; no global trust settings are changed.
    // https://code.claude.com/docs/en/mcp#project-scope
    for (const [file, data] of [
      [server, fs.readFileSync(path.join(root, 'bench/host-stream/elicitation-server.mjs'))],
      [
        `${dir}/.mcp.json`,
        Buffer.from(JSON.stringify({ mcpServers: { 'host-stream-probe': { command: ctx.state.nodePath, args: [server, evidence] } } })),
      ],
    ])
      expect((await ctx.m.run(`cat > ${quote(file)}`, data)).code === 0, `Cannot write ${file}.`);
    const chatId = `claude:${crypto.randomUUID()}`;
    const c = await begin(
      { ...ctx, state: { ...ctx.state, dataDir: dir } },
      chatId,
      'claude',
      'Call the host-stream-probe MCP probe tool exactly once. It asks a test form and an inert URL. Report the tool result verbatim. Do not use any other tool.',
    );
    try {
      const first = await waitCard(c, chatId, ['question', 'permission']);
      let form = first;
      if (first.kind === 'permission') {
        expect(
          first.options.some((o) => o.optionId === 'allow'),
          'Unexpected approval before the form.',
        );
        await c.request('chat.answer', { chatId, epoch: 1, key: crypto.randomUUID(), requestId: first.requestId, optionId: 'allow' });
        form = await waitCard(c, chatId, ['question']);
      }
      const word = `verify-${crypto.randomUUID()}`;
      expect(
        form.question.form.fields.some((f) => f.key === 'word'),
        'No MCP word field.',
      );
      await c.request('chat.answer', {
        chatId,
        epoch: 1,
        key: crypto.randomUUID(),
        requestId: form.question.id,
        form: { action: 'accept', content: { word } },
      });
      const link = await waitCard(c, chatId, ['permission']);
      expect(link.toolCall.rawInput?.url === LINK && link.options.some((o) => o.optionId === 'done'), 'No inert URL elicitation card.');
      await c.request('chat.answer', { chatId, epoch: 1, key: crypto.randomUUID(), requestId: link.requestId, optionId: 'done' });
      const reply = (await c.waitFor(isReply(chatId), 120_000)).frame.item;
      const read = await ctx.m.run(`cat ${quote(evidence)}`);
      expect(read.code === 0, 'No server-side answer evidence.');
      const received = JSON.parse(read.stdout);
      expect(
        !reply.error && received.form?.action === 'accept' && received.form.content?.word === word && received.link?.action === 'accept',
        'The stdio server did not receive the exact form answer and URL acceptance.',
      );
      return `Real MCP form and inert URL answered; result contains ${word}. No browser or OAuth opened.`;
    } finally {
      c.close();
    }
  } finally {
    await ctx.m.run(`rm -rf ${quote(dir)}`);
  }
}

/** @param {any} ctx @param {any} io */
export async function lostHostCheck(ctx, { begin, framesOf, isReply, connect, harness }) {
  const chatId = harness === 'claude' ? `claude:${crypto.randomUUID()}` : crypto.randomUUID();
  const marker = `handoff-${crypto.randomUUID()}`;
  const c = await begin(
    ctx,
    chatId,
    harness,
    `Remember the verification word ${marker}. Run exactly this shell command, then say "ended": echo handoff-ok`,
  );
  try {
    const reply = (await c.waitFor(isReply(chatId), 240_000)).frame.item;
    expect(!reply.error, `Source turn failed: ${reply.error}`);
    const frames = framesOf(c, chatId);
    const items = [
      ...(frames.find((f) => f.t === 'hello')?.snapshot?.items ?? []),
      ...frames.filter((f) => f.t === 'durable').map((f) => f.item),
    ];
    expect(ctx.state.os === 'Darwin', 'R7 currently verifies a launchd Host on macOS only.');
    // Unload the run-installed service: KeepAlive must not silently bring the source back.
    expect((await ctx.m.run(launchdStop())).code === 0, 'Cannot unload the run-installed Host.');
    const check = connect(ctx);
    try {
      await check.request('status');
      throw new Error('The source still answers after stopping it.');
    } catch (error) {
      expect(error.code === 'closed', `Source offline not proven: ${error.message}`);
    } finally {
      check.close();
    }
    const dir = fs.mkdtempSync(path.join(ctx.outDir, 'local-continue-'));
    const rev = Math.max(0, ...frames.map((f) => f.rev ?? 0));
    const local = await localContinuation({ dir, chatId, harness, items, rev });
    expect(/Ran `[^`]*handoff-ok/.test(local.text), 'The production inbox lost the command.');
    expect(
      local.text.includes(marker) && local.text.includes(String(reply.text).slice(0, 20)),
      'The production inbox lost the conversation.',
    );
    // Only the model consumer crosses this boundary: it runs in the VM, never on the user's Mac.
    const resumed = await ctx.m.run(
      'cd /tmp && codex exec --skip-git-repo-check --sandbox read-only -',
      Buffer.from(`${local.text}\n\nWhat verification word did I ask you to remember? Reply with the word only. Do not use tools.`),
    );
    expect(resumed.code === 0 && resumed.stdout.includes(marker), `Target Codex did not recall the word: ${resumed.stderr.slice(-300)}`);
    local.done();
    expect(local.pending() === null, 'The consumed inbox was not cleared.');
    return `Source offline; production app ownership moved to local at epoch 2; inbox consumed by real Codex, which recalled ${marker}. Mirror folding, GUI/SwitchRunner send and mid-turn loss not covered.`;
  } finally {
    c.close();
  }
}
