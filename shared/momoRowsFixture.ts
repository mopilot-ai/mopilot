// One row of every kind MoMo's chat can hold, in every state a card can be in: what both UIs' fakes import (so they draw what the Host really writes) and what the Host's row writer is tested against.
import type { MomoApprovalView, MomoChatRow, MomoMachineRef, MomoQuestionView, MomoResultView, MomoWatchChangedView } from './momoView.ts';

export const FIXTURE_MACHINE: MomoMachineRef = { machineId: 'home-aaaa-1111', name: 'Studio' };
export const FIXTURE_AT = 1_700_000_000_000;

const approval = (over: Partial<MomoApprovalView>): MomoApprovalView => ({
  id: 'card-1',
  action: 'send-email',
  title: 'Send this email?',
  recipients: [{ name: 'Dana', address: 'dana@example.com', outsideCompany: true }],
  subject: 'Re: contract',
  attachments: [],
  body: 'Thanks, signed copy attached.',
  fields: [],
  expiresAt: FIXTURE_AT + 86_400_000,
  status: 'pending',
  answeredElsewhere: null,
  failure: null,
  canAskAgain: false,
  editable: true,
  ...over,
});

const question = (over: Partial<MomoQuestionView>): MomoQuestionView => ({
  id: 'ask-1',
  title: 'Which calendar should I use?',
  body: 'You have two.',
  options: [
    { id: 'work', label: 'Work' },
    { id: 'home', label: 'Home' },
  ],
  expiresAt: null,
  status: 'pending',
  answer: null,
  ...over,
});

export const FIXTURE_RESULT: MomoResultView = {
  taskId: 'task-1',
  settle: 1,
  title: 'Reconcile March invoices',
  state: 'done',
  summary: 'Matched 41 of 42 invoices; one is missing a PO number.',
  files: ['reconciliation-march.xlsx'],
  evidence: '41 rows matched in the ledger; row 17 has no PO.',
  checked: 'The report lists every invoice and the one gap.',
  machine: FIXTURE_MACHINE,
  sessionId: 'claude:session-1',
  untrusted: true,
  actions: [{ id: 'review', label: 'Review' }],
};

export const FIXTURE_WATCH: MomoWatchChangedView = {
  taskId: 'task-2',
  title: 'Price of the flight to Berlin',
  detail: 'It dropped from 212 to 168.',
  machine: FIXTURE_MACHINE,
};

/** Approval and question cards in each of their states, and the other kinds, each with a stable id. */
export const FIXTURE_ROWS: MomoChatRow[] = [
  ...(
    ['pending', 'approved', 'denied', 'expired', 'answered-elsewhere', 'consumed', 'completed', 'failed', 'uncertain', 'void'] as const
  ).map(
    (status, i): MomoChatRow => ({
      kind: 'approval',
      id: `approval:${status}`,
      at: FIXTURE_AT + i,
      approval: approval({
        id: `card-${status}`,
        status,
        answeredElsewhere: status === 'answered-elsewhere' ? { device: 'iPhone', at: FIXTURE_AT, outcome: 'approved' } : null,
        failure: status === 'failed' ? { cause: 'Gmail refused the send.', fix: { id: 'retry', label: 'Retry' } } : null,
        canAskAgain: status === 'expired' || status === 'denied' || status === 'uncertain',
        // a card can be changed only while it waits for an answer
        editable: status === 'pending',
      }),
    }),
  ),
  ...(['pending', 'answered', 'answered-elsewhere', 'expired', 'void'] as const).map(
    (status, i): MomoChatRow => ({
      kind: 'question',
      id: `question:${status}`,
      at: FIXTURE_AT + 100 + i,
      question: question({
        id: `ask-${status}`,
        status,
        answer: status === 'answered' || status === 'answered-elsewhere' ? { optionId: 'work', device: 'iPhone', at: FIXTURE_AT } : null,
      }),
    }),
  ),
  { kind: 'result', id: 'result:task-1:1', at: FIXTURE_AT + 200, result: FIXTURE_RESULT },
  {
    kind: 'result',
    id: 'result:task-3:1',
    at: FIXTURE_AT + 201,
    result: { ...FIXTURE_RESULT, taskId: 'task-3', state: 'failed', summary: 'Claude Code is signed out on Studio.' },
  },
  { kind: 'watch-changed', id: 'watch:task-2:1', at: FIXTURE_AT + 202, watch: FIXTURE_WATCH },
];

/**
 * A reply draft row: in the contract, not yet drawn by either client, so it is not one of FIXTURE_ROWS (every row there is drawn). A client that gets it
 * must ignore it safely: the Mac shows its "can't draw this" line, the phone nothing.
 */
export const FIXTURE_DRAFT_ROW: MomoChatRow = {
  kind: 'draft',
  id: 'draft:acme-renewal:1',
  at: FIXTURE_AT + 203,
  draft: { to: ['ana@acme.example'], subject: 'Re: Acme renewal', body: 'Thanks Ana, Thursday works for me.' },
  matter: { key: 'acme-renewal', title: 'Acme renewal' },
  untrusted: true,
  truncated: false,
};
