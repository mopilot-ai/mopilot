// What the fake Claude CLI asks the app mid-turn, as the CLI's control requests do: an MCP form, a multi-select question and a tool approval to deny.
//   - "ELICIT": an MCP form (elicitation) for a workspace;
//   - "ASKMULTI": a multiSelect AskUserQuestion over three files;
//   - "DENYME": a WebFetch approval;
//   - "ASKPAIR": two WebFetch approvals asked at once, so two approval cards queue in the chat;
//   - "SAFETYASK": a Bash approval in any mode, with a description and Claude Code's own reason, as its shell-parse safety check asks.
// Each answer is logged ({kind: 'elicitation' | 'question' | 'denial'}) and comes back as a suffix for the reply.
import { randomUUID } from 'node:crypto';

const toolUseId = () => `toolu_fake_${randomUUID().slice(0, 8)}`;

/**
 * @param {string} text the turn's prompt
 * @param {{ askSdk: (request: object) => Promise<any>, log: (entry: object) => void }} cli
 * @returns {Promise<string>} what goes after the reply
 */
export async function askTheApp(text, { askSdk, log }) {
  let reply = '';
  if (text.includes('ELICIT')) {
    const r = (
      await askSdk({
        subtype: 'elicitation',
        mcp_server_name: 'fake-mcp',
        message: 'Which workspace?',
        mode: 'form',
        requested_schema: { type: 'object', properties: { workspace: { type: 'string', title: 'Workspace' } } },
      })
    )?.response;
    log({ kind: 'elicitation', response: r });
    reply += ` [elicitation: ${r?.action}]`;
  }
  if (text.includes('ASKMULTI')) {
    const input = {
      questions: [
        {
          question: 'Which files?',
          header: 'Files',
          multiSelect: true,
          options: [
            { label: 'a.ts', description: '' },
            { label: 'b.ts', description: '' },
            { label: 'c.ts', description: '' },
          ],
        },
      ],
    };
    const r = (
      await askSdk({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: toolUseId(), permission_suggestions: [] })
    )?.response;
    log({ kind: 'question', response: r });
    reply += ` [answers: ${JSON.stringify(r?.updatedInput?.answers ?? null)}]`;
  }
  if (text.includes('DENYME')) {
    const r = (
      await askSdk({
        subtype: 'can_use_tool',
        tool_name: 'WebFetch',
        input: { url: 'https://example.test/' },
        tool_use_id: toolUseId(),
        permission_suggestions: [],
      })
    )?.response;
    log({ kind: 'denial', response: r });
    reply += ` [${r?.behavior}: ${r?.message ?? ''}]`;
  }
  if (text.includes('ASKPAIR')) {
    const ask = (url) =>
      askSdk({ subtype: 'can_use_tool', tool_name: 'WebFetch', input: { url }, tool_use_id: toolUseId(), permission_suggestions: [] });
    const both = await Promise.all([ask('https://one.test/'), ask('https://two.test/')]);
    reply += ` [pair: ${both.map((r) => r?.response?.behavior).join(',')}]`;
  }
  if (text.includes('SAFETYASK')) {
    const r = (
      await askSdk({
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: "python3 -I - <<'EOF'\nprint('$(x)')\nEOF", description: 'Rewrite basic picker tests and run' },
        tool_use_id: toolUseId(),
        permission_suggestions: [],
        description: 'Rewrite basic picker tests and run',
        decision_reason: SAFETY_REASON,
      })
    )?.response;
    log({ kind: 'safety', response: r });
    reply += ` [safety: ${r?.behavior}]`;
  }
  return reply;
}

/** What Claude Code 2.1.330 says when it asks about a command it cannot parse, even in full access. */
export const SAFETY_REASON =
  "Claude Code can't be sure it read this command the way the shell will, so it can't rule out a dangerous removal. Read the command, and don't go ahead if you can't tell what it does.";
