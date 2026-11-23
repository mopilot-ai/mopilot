// A card's answer (the approval UI's Codex decision shapes) as the Claude Agent SDK's: a PermissionResult for a tool, an
// ElicitationResult for an MCP server's request, a decline with the user's note. The window and main (Chrome's side
// panel, electron/app/chromePanel.cjs) answer Claude Code's cards with it alike.

/**
 * @param {string} method the card's request method
 * @param {Record<string, any> | null | undefined} input the tool input the approval was asked about
 * @param {{ action?: string, content?: unknown, _meta?: unknown, answers?: Record<string, { answers?: string[] } | undefined>,
 *           decision?: string | { acceptWithExecpolicyAmendment?: unknown }, reason?: unknown } | null | undefined} result
 *   the card's answer, in the Codex decision shapes (and an MCP ElicitResult's)
 * @param {unknown[] | null} [suggestions] the rules the CLI proposed, sent back for "for this session"
 * @returns {{ behavior?: 'allow' | 'deny', updatedInput?: Record<string, unknown> | null, updatedPermissions?: unknown[],
 *             message?: string, interrupt?: boolean, action?: string, content?: unknown, _meta?: unknown }}
 */
export function claudeAnswer(method, input, result, suggestions) {
  // an MCP ElicitResult: content only with accept; the answer's _meta (a grant's scope, say) goes back as given
  if (method === 'mcpServer/elicitation/request')
    return {
      action: result?.action ?? 'decline',
      ...(result?.action === 'accept' && result?.content ? { content: result.content } : {}),
      ...(result?._meta != null ? { _meta: result._meta } : {}),
    };
  if (method === 'item/tool/requestUserInput') {
    // asked nothing: allowed with no answers, as Claude Code's own card answers it
    if (!input?.questions?.length) return { behavior: 'allow', updatedInput: { ...input, answers: {} } };
    /** @type {Record<string, string>} */
    const answers = {};
    for (const [i, q] of input.questions.entries()) {
      const a = result?.answers?.[String(i)]?.answers ?? [];
      // a multiSelect question takes every option picked
      if (a.length) answers[q.question] = a.join(', ');
    }
    return Object.keys(answers).length
      ? { behavior: 'allow', updatedInput: { ...input, answers } }
      : { behavior: 'deny', message: 'The user skipped the question.' };
  }
  const d = result?.decision;
  if (d === 'accept' || d === 'approved') return { behavior: 'allow', updatedInput: input };
  if (d === 'acceptForSession' || d === 'approved_for_session' || (typeof d === 'object' && d?.acceptWithExecpolicyAmendment))
    return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions ?? undefined };
  const note = typeof result?.reason === 'string' && result.reason.trim() ? result.reason.trim() : null;
  if (d === 'cancel')
    return {
      behavior: 'deny',
      message: note ? `The user cancelled this action: ${note}` : 'The user cancelled this action.',
      interrupt: true,
    };
  return { behavior: 'deny', message: note ? `The user declined this action: ${note}` : 'The user declined this action.' };
}
