// Cursor CLI over ACP: `agent acp` (installed as cursor-agent or agent). Modes agent, plan and ask;
// plan counts as read-only for computer use, since plan mode has been seen writing files. Its
// extension methods map onto the thread: cursor/update_todos is the turn's plan, cursor/create_plan
// is shown as the plan's text and accepted; the rest are answered "not supported".
const { ownTable } = require('../../../shared/ownTable.mjs');
const STATUS = ownTable({ pending: 'pending', in_progress: 'in_progress', completed: 'completed', done: 'completed' });

module.exports = {
  label: 'Cursor',
  bins: ['cursor-agent', 'agent'],
  args: ['acp'],
  privacyDefaults: [],
  admission: { handshakeTimeoutMs: 10_000 },
  anchors: { ask: 'readOnly', plan: 'readOnly', agent: 'ask' },
  plan: { mode: 'plan' },
  // Cursor's own agent, ask and plan modes; how much it may do is its own settings' (#1875)
  agentModes: ['agent', 'ask', 'plan'],
  instructionsFiles: ['AGENTS.md'],
  extensions: {
    'cursor/update_todos': (p) => ({
      update: {
        sessionUpdate: 'plan',
        entries: (p?.todos ?? []).map((t) => ({
          content: String(t.content ?? t.title ?? ''),
          status: STATUS[t.status] ?? 'pending',
          priority: 'medium',
        })),
      },
      result: {},
    }),
    'cursor/create_plan': (p) => ({
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(p?.plan ?? p?.content ?? '') } },
      result: { accepted: true },
    }),
  },
};
