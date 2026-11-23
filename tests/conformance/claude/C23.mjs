// D-68, passive channels: while a foreground `for ...; sleep 2` Bash command runs, does ANYTHING reach the SDK consumer before the
// final tool result? Everything that could carry progress is switched on at once: includePartialMessages (stream_event),
// agentProgressSummaries, includeHookEvents (hook_started/progress/response), SDK hook callbacks for PreToolUse, PostToolUse,
// Notification, PostToolUseFailure and others. One short turn on the cheapest model, in a temp dir.
// The window starts at task_started, which the CLI emits only a few seconds after the tool_use (the command already runs).
import { open } from '../lib/claude.mjs';

export const id = 'C23';
export const title = 'D-68 passive channels: stream_event, task_progress, hook events and hooks while a foreground Bash runs';
export const timeoutMs = 300000;

const CMD = 'for i in 1 2 3; do echo line$i; sleep 2; done';
const HOOKS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PermissionRequest',
];

export default async function run(ctx) {
  const hookCalls = [];
  const hooks = Object.fromEntries(
    HOOKS.map((ev) => [ev, [{ hooks: [async (input) => (hookCalls.push({ ev, at: Date.now(), tool: input.tool_name ?? null }), {})] }]]),
  );
  const s = open(ctx, 'passive', {
    cwd: ctx.cwd('bash'),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    includeHookEvents: true,
    agentProgressSummaries: true,
    keepStreamEvents: true,
    hooks,
  });
  await s.turn(`Run exactly this one bash command with the Bash tool, do not change it, then reply with just "done":\n${CMD}`, {}, 150000);
  await s.close();

  const at = (m) => m.__at;
  const use = s.msgs.find((m) => m.type === 'assistant' && m.message?.content?.some((b) => b.type === 'tool_use' && b.name === 'Bash'));
  const useId = use?.message.content.find((b) => b.type === 'tool_use' && b.name === 'Bash')?.id;
  const resultMsg = s.msgs.find(
    (m) =>
      m.type === 'user' &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'tool_result' && b.tool_use_id === useId),
  );
  // the window in which the command runs: from the task start (or the tool_use message) to the tool result
  const started = s.msgs.find((m) => m.subtype === 'task_started');
  const t0 = at(started ?? use);
  const t1 = at(resultMsg);
  const inside = s.msgs.filter((m) => at(m) >= t0 && at(m) < t1 && m !== started);
  const label = (m) =>
    m.type === 'stream_event'
      ? `stream_event/${m.event?.type}${m.event?.delta?.type ? `:${m.event.delta.type}` : ''}`
      : `${m.type}${m.subtype ? `/${m.subtype}` : ''}`;
  const counts = {};
  for (const m of inside) counts[label(m)] = (counts[label(m)] ?? 0) + 1;
  const outputCarrying = inside.filter((m) => /line[123]/.test(JSON.stringify(m)));
  const o = {
    windowMs: t1 - t0,
    taskStartedLagMs: at(started) - at(use),
    insideWindowByType: counts,
    insideWindowMentioningCommandOutput: outputCarrying.map(label),
    taskStarted: started && {
      task_type: started.task_type,
      is_backgrounded: started.is_backgrounded,
      hasOutputFile: 'output_file' in started,
    },
    allTypesInTurn: [...new Set(s.msgs.map(label))].sort(),
    hookCalls: hookCalls.map((h) => ({ ev: h.ev, tool: h.tool, relMs: h.at - t0 })),
    hookEventSubtypes: [...new Set(s.msgs.filter((m) => /^hook_/.test(m.subtype ?? '')).map((m) => `${m.subtype}:${m.hook_event ?? ''}`))],
  };
  return ctx.result(o, {
    'the command ran as a foreground local_bash task': started?.task_type === 'local_bash' && started?.is_backgrounded === false,
    'no stream_event, task_progress, tool_progress or other message arrives while the command runs (only task bookends)': inside.every(
      (m) => m.subtype === 'task_notification',
    ),
    'no message inside the window carries the command output': outputCarrying.length === 0,
    'no PostToolUse or Notification hook fires before the command ends': hookCalls
      .filter((h) => /PostToolUse|Notification/.test(h.ev))
      .every((h) => h.at >= t1 - 500),
    'PreToolUse and PostToolUse hook callbacks do fire (the SDK hooks option works)': ['PreToolUse', 'PostToolUse'].every((ev) =>
      hookCalls.some((h) => h.ev === ev),
    ),
  });
}
