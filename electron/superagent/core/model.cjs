// Superagent domain model: Trigger, Thread, Eval, Decision, Mandate, Ticket and Assignment, with the helpers that read them.
// Ported to CommonJS from deepseek-ai/dsh-superagent-prototype src/core/model.ts (MIT, Copyright (c) 2026 DeepSeek Harness Team; see NOTICE).
// Types are JSDoc only. Left out for now (S2 and S3 need them): followupOwners, settled, reached, readUntil and the
// Input kinds that only workers produce.

/** @typedef {{ source: string, id: string }} ActorRef Actor identity in the source's own vocabulary. */
/** @typedef {{ source: string, id: string }} ThreadRef Thread identity; the rule that derives `id` belongs to the source. */
/** @typedef {{ source: string, thread: string, address: Record<string, string> }} ChannelRef Write-only address on a thread. */
/** @typedef {'explicit' | 'inferred'} Strength */
/** @typedef {'off' | 'observe' | 'auto'} AcceptMode */
/**
 * @typedef {object} Trigger One immutable event produced by a source; `text` and `meta` are untrusted external data.
 * @property {string} id
 * @property {string} source
 * @property {ThreadRef[]} threads the first is the primary thread that hosts its evaluation
 * @property {ActorRef} actor
 * @property {boolean} human source-declared: written by a person rather than a bot, CI or this agent
 * @property {'mention' | 'direct'} [addressed]
 * @property {string} at
 * @property {string} text
 * @property {ChannelRef} [channel]
 * @property {string} [url]
 * @property {Record<string, unknown>} meta
 */
/**
 * @typedef {object} Mandate Immutable authorization produced by an accept decision.
 * @property {Strength} strength
 * @property {string} policyVersion
 * @property {Record<string, unknown>} basis how the gate admitted it
 * @property {ActorRef} actor
 * @property {string} scope
 */
/**
 * @typedef {object} Evaluation Active trigger evaluation on a thread; at most one per thread.
 * @property {string} id
 * @property {string} threadKey
 * @property {string[]} triggerIds
 * @property {Strength} strength
 * @property {ActorRef} actor
 * @property {Record<string, unknown>} basis
 * @property {string} policyVersion
 * @property {string} startedAt
 * @property {string} deadline
 */
/**
 * @typedef {object} Thread Thread aggregate: the consistency boundary of eval and holder of subscriptions.
 * @property {string} key
 * @property {ThreadRef} ref
 * @property {string} createdAt
 * @property {string} [lastAt] time of the newest trigger
 * @property {string[]} subscriptions tickets subscribed to this thread
 * @property {string[]} correlated keys of threads that shared a trigger with this one
 * @property {string[]} pending triggers waiting for the next eval
 * @property {Evaluation} [evaluating]
 * @property {Record<string, unknown>} meta
 */
/** @typedef {'ignore' | 'accept' | 'reopen' | 'stop' | 'unavailable'} DecisionKind */
/**
 * @typedef {object} Decision Outcome of one eval, recorded on the thread.
 * @property {string} id
 * @property {string} evalId
 * @property {string} threadKey
 * @property {string[]} triggerIds
 * @property {string} policyVersion
 * @property {string} at
 * @property {DecisionKind} kind
 * @property {import('./reasons.cjs').Reason[]} reason
 * @property {Strength} strength
 * @property {string} [ticketId]
 * @property {Mandate} [mandate]
 */
/** @typedef {'pending' | 'running' | 'ended'} AssignmentState */
/** @typedef {'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'} ReportState */
/**
 * @typedef {object} Assignment Binding between a ticket and one executor instance.
 * @property {string} id
 * @property {AssignmentState} state
 * @property {string} createdAt
 * @property {string} [endedAt]
 * @property {{ state: ReportState, summary: string, at: string }} [report]
 */
/** @typedef {{ id: string, kind: 'trigger', triggerId: string, at: string, human?: true, context?: true } | { id: string, kind: 'text' | 'note', text: string, at: string }} TicketInput */
/**
 * @typedef {object} Ticket Ticket aggregate: an authorized work item with its assignments and inputs.
 * @property {string} id
 * @property {string} title
 * @property {string} decisionId
 * @property {Mandate} mandate
 * @property {ChannelRef[]} channels
 * @property {{ at: string, by: 'executor' | 'human', outcome: 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped', reason?: string }} [ended]
 * @property {{ id: string, question: string, triggerId?: string }} [attention] open question for a person
 * @property {Assignment[]} assignments
 * @property {TicketInput[]} inputs
 * @property {string[]} undelivered inputs not yet handed to a running assignment
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {{ triggerId: string, triggerIds: string[] }} origin
 * @property {{ error: string, at: string }} [delivery] the latest failed delivery of an input
 */

/** Stable key of a thread across the whole domain. @param {ThreadRef} ref */
const threadKey = (ref) => `${ref.source}:${ref.id}`;

/**
 * Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and
 * SQL; values that do not parse as a timestamp are returned unchanged.
 * @param {string} value
 */
function isoTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
}

/** Whether a ticket is open: it has not ended. @param {Pick<Ticket, 'ended'>} ticket */
const liveTicket = (ticket) => !ticket.ended;
/** How a ticket ended. @param {Pick<Ticket, 'ended'>} ticket */
const ticketOutcome = (ticket) => ticket.ended?.outcome;
/** @param {Ticket} ticket */
const runningAssignment = (ticket) => ticket.assignments.find((a) => a.state === 'running');
/** @param {Ticket} ticket */
const latestAssignment = (ticket) => ticket.assignments.at(-1);
/** The latest report any of a ticket's assignments made, which is what the ticket last said. @param {Pick<Ticket, 'assignments'>} ticket */
const latestReport = (ticket) => ticket.assignments.findLast((a) => a.report)?.report;

/**
 * Whether a ticket waits for a person: its latest assignment reported blocked or failed, and no person's message reached
 * it since.
 * @param {Ticket} ticket
 */
function waitsForPerson(ticket) {
  const report = latestAssignment(ticket)?.report;
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false;
  return !ticket.inputs.some((i) => i.kind === 'trigger' && i.human && !i.context && i.at > report.at);
}

module.exports = {
  threadKey,
  isoTime,
  liveTicket,
  ticketOutcome,
  runningAssignment,
  latestAssignment,
  latestReport,
  waitsForPerson,
};
