// Superagent ticket stage: where a ticket stands (waiting on a person, working, idle, ended) and whether it can be retried.
// Ported to CommonJS from deepseek-ai/dsh-superagent-prototype src/core/stage.ts (MIT, Copyright (c) 2026 DeepSeek Harness Team; see NOTICE).
const { latestAssignment, waitsForPerson } = require('./model.cjs');

/**
 * Classifies a ticket's stage; the first matching row of the prototype's table (docs/003) wins.
 * @param {import('./model.cjs').Ticket} ticket
 * @returns {{ stage: 'person', action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' } | { stage: 'working', action?: 'queued' } | { stage: 'idle' } | { stage: 'ended' }}
 */
function ticketStage(ticket) {
  if (ticket.ended) return { stage: 'ended' };
  if (ticket.delivery) return { stage: 'person', action: 'delivery' };
  if (ticket.attention) return { stage: 'person', action: 'answer' };
  const assignment = latestAssignment(ticket);
  const report = assignment?.report?.state;
  if (report === 'ready') return { stage: 'person', action: 'review' };
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) return { stage: 'person', action: report };
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' };
  if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' };
  return { stage: 'working' };
}

/** True when an open ticket is stalled on a blocked or failed report without a newer person's message, or has a failed input delivery. @param {import('./model.cjs').Ticket} ticket */
const canRetry = (ticket) => !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery);

module.exports = { ticketStage, canRetry };
