// The scripted Claude fixture's /code-review: a forked review task whose findings come back as the result text, or
// with REPORT in its args as a ReportFindings tool call on the main thread, as the CLI's /code-review reports them.
import { randomUUID } from 'node:crypto';

/** The two findings a REPORT review reports, in the CLI's ReportFindings input shape. */
const REPORTED = [
  {
    file: 'calc.js',
    line: 1,
    summary: '`div` multiplies instead of dividing',
    short_summary: '`div` multiplies instead of dividing',
    failure_scenario: 'div(6, 3) returns 18 instead of 2',
    category: 'correctness',
  },
  {
    file: 'calc.js',
    line: 1,
    summary: 'No test covers `div`',
    short_summary: 'No test covers `div`',
    failure_scenario: 'A regression in div ships unnoticed',
    category: 'test-coverage',
  },
];

export function createFakeClaudeReview({ sessionId, send, log, record, resolvedModel, result, sleep, stepMs }) {
  const base = { session_id: sessionId };
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  /** One main-thread message, recorded in the transcript as the CLI records it. */
  function said(type, message) {
    const uuid = randomUUID();
    record(type, { message, uuid });
    send({ type, message, parent_tool_use_id: null, ...base, uuid });
  }
  const assistant = (content, stop) => ({
    id: `msg_fake_${randomUUID().slice(0, 8)}`,
    type: 'message',
    role: 'assistant',
    model: resolvedModel(),
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const toolResult = (id, content) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });

  /**
   * "/code-review <level> REPORT": the review as the CLI runs it with CLAUDE_CODE_REPORT_FINDINGS (the stream
   * tests/claudeTranslate.test.ts replays): inline on the main thread, the diff read, the findings as a
   * ReportFindings call the app turns into its code-review card, and a line of text after it.
   */
  function runReported(args, started) {
    const level = /\b(low|medium|high|xhigh|max)\b/.exec(args)?.[1] ?? 'medium';
    const diffId = `toolu_fake_${randomUUID().slice(0, 8)}`;
    said('assistant', assistant([{ type: 'tool_use', id: diffId, name: 'Bash', input: { command: 'git diff HEAD' } }], 'tool_use'));
    said('user', toolResult(diffId, '--- a/calc.js'));
    const reportId = `toolu_fake_${randomUUID().slice(0, 8)}`;
    const input = { level, findings: REPORTED };
    said('assistant', assistant([{ type: 'tool_use', id: reportId, name: 'ReportFindings', input }], 'tool_use'));
    said('user', toolResult(reportId, `${REPORTED.length} findings reported.`));
    const text = 'I found two issues in `calc.js`.';
    said('assistant', assistant([{ type: 'text', text }], 'end_turn'));
    result(started, false, text, usage);
  }

  /**
   * "/code-review [args]" (or its alias /review) as the CLI runs it (C13): a forked task whose own
   * messages carry parent_tool_use_id "forked-command-code-review", an ambient task_notification, then
   * the findings as the command's synthetic output and the result. With REPORT in its args, runReported.
   */
  async function runReview(msg, args, started) {
    const content = msg.message?.content;
    log({
      kind: 'review',
      args,
      blocks: Array.isArray(content) ? content.map((b) => (b.type === 'image' ? `image:${b.source?.media_type}` : b.type)) : ['string'],
    });
    if (/\bREPORT\b/.test(args)) return runReported(args, started);
    const taskId = `task_${randomUUID().slice(0, 6)}`;
    send({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      description: '/code-review',
      subagent_type: 'general-purpose',
      is_backgrounded: false,
      task_type: 'local_agent',
      ...base,
      uuid: randomUUID(),
    });
    const fork = 'forked-command-code-review';
    const toolId = `toolu_fake_${randomUUID().slice(0, 8)}`;
    send({
      type: 'assistant',
      message: {
        id: `msg_fake_${randomUUID().slice(0, 8)}`,
        type: 'message',
        role: 'assistant',
        model: resolvedModel(),
        content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'git diff HEAD' } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      parent_tool_use_id: fork,
      ...base,
      uuid: randomUUID(),
    });
    send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: '--- a/calc.js' }] },
      parent_tool_use_id: fork,
      ...base,
      uuid: randomUUID(),
    });
    await sleep(stepMs);
    send({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      status: 'completed',
      output_file: '',
      summary: '/code-review',
      skip_transcript: true,
      ambient: true,
      ...base,
      uuid: randomUUID(),
    });
    const findings = `- calc.js:1 — \`div\` multiplies instead of dividing (review ${args || 'default'})`;
    const message = {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: findings }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    };
    const uuid = randomUUID();
    record('assistant', { message, uuid });
    send({ type: 'assistant', message, parent_tool_use_id: null, ...base, uuid });
    result(started, false, findings, usage);
  }

  return { runReview };
}
