// Fixture data for MoMo's home surfaces, as the design shows them (Acme, Dana Lee, Studio): what the store holds until the home lane's seam answers.
import type { MomoView } from '../../../../shared/momoView';

export const FIXTURE_NOW = Date.UTC(2030, 10, 24, 14, 14);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MACHINE_IDS: Record<string, string> = { Studio: 'studio', 'This Mac': 'this-mac', 'Mac mini': 'mac-mini' };
const M = (name: string) => ({ machineId: MACHINE_IDS[name], name });

export function fixtureView(): MomoView {
  return {
    home: {
      state: 'running',
      homeMachineId: 'studio',
      leaseEpoch: 1,
      machineName: 'Studio',
      movedAway: null,
      update: null,
      stateSince: FIXTURE_NOW - 3 * DAY,
      lastSeenAt: FIXTURE_NOW,
      move: null,
      agentProblem: null,
      machines: [
        {
          machineId: 'studio',
          name: 'Studio',
          isThisDevice: false,
          isHome: true,
          status: 'online',
          note: 'Keeps running when your Mac sleeps',
          recommended: true,
          agentsSignedIn: ['Claude Code', 'Codex'],
        },
        {
          machineId: 'this-mac',
          name: 'This Mac',
          isThisDevice: true,
          isHome: false,
          status: 'online',
          note: 'Stops when the lid closes',
          recommended: false,
          agentsSignedIn: ['Claude Code'],
        },
        {
          machineId: 'mac-mini',
          name: 'Mac mini',
          isThisDevice: false,
          isHome: false,
          status: 'needs-update',
          note: 'MoPilot there is out of date',
          recommended: false,
          agentsSignedIn: [],
        },
        {
          machineId: 'cloud',
          name: 'Cloud machine',
          isThisDevice: false,
          isHome: false,
          status: 'not-set-up',
          note: 'Wakes when MoMo has work, stops when idle',
          recommended: false,
          agentsSignedIn: [],
        },
      ],
      sources: [
        { id: 'gmail', account: 'du@studio.example', access: 'read-only', status: 'ok', progress: null },
        { id: 'calendar', account: 'du@studio.example', access: 'read-only', status: 'ok', progress: null },
      ],
    },
    setup: { step: 'done', google: 'connected', notifications: 'allowed' },
    chat: [
      {
        kind: 'brief',
        id: 'brief-1',
        at: FIXTURE_NOW - 6 * 60 * MIN,
        brief: {
          day: '2030-11-24',
          greeting: 'Good morning, Du.',
          attention: { text: 'Dana Lee needs the revised Acme quote by Friday.', source: 'Gmail · “Re: Acme renewal” · Nov 18' },
          offers: [
            {
              id: 'offer-1',
              title: 'Draft the reply with the quote for 200 seats?',
              why: 'You agreed to $48k on Nov 11. I will attach the sheet and ask before sending.',
            },
          ],
          overnight: { read: 38, notesUpdated: 4, rulesLearned: 1 },
          leftOut: [{ id: 'l1', reason: 'Your Muji package shipped' }],
        },
      },
      {
        kind: 'assistant',
        id: 'a1',
        at: FIXTURE_NOW - 2 * MIN,
        text: 'Dana Lee just replied on the Acme renewal. She asks whether the $48k price holds if they start on Dec 1 instead of Jan 1.',
        source: 'Gmail · “Re: Acme renewal” · 2 minutes ago',
        whyTold: 'Told you now: client replies',
        notNeeded: null,
      },
      {
        kind: 'assistant',
        id: 'a2',
        at: FIXTURE_NOW - 30_000,
        text: 'Also: your Muji package arrives tomorrow.',
        source: null,
        whyTold: null,
        notNeeded: { suggestion: null },
      },
      { kind: 'user', id: 'u1', at: FIXTURE_NOW - 90_000, text: 'Yes, it holds. Tell her, and attach the quote.', delivery: 'accepted' },
      {
        kind: 'approval',
        id: 'card-row-1',
        at: FIXTURE_NOW - 60_000,
        approval: {
          id: 'card-1',
          action: 'send-email',
          title: 'Send this email?',
          recipients: [{ name: 'Dana Lee', address: 'dana.lee@acme.example', outsideCompany: true }],
          subject: 'Re: Acme renewal',
          attachments: ['Acme-quote-200-seats.pdf'],
          body: 'Hi Dana, yes, the $48k price holds with a Dec 1 start. The quote for 200 seats is attached and is valid until Nov 30. Happy to walk through it this week.',
          expiresAt: null,
          status: 'pending',
          fields: [],
          answeredElsewhere: null,
          failure: null,
          canAskAgain: false,
          editable: true,
        },
      },
    ],
    tasks: [
      {
        id: 't-review',
        title: 'Send the reply to Dana Lee',
        doneMeans: 'The reply is sent to Dana with the quote attached.',
        state: 'needs_you',
        where: { machine: M('Studio'), agent: 'Claude Code' },
        origin: 'asked',
        attempts: 1,
        attemptCap: 3,
        startedAt: FIXTURE_NOW - 3 * MIN,
        step: 'Draft ready · waiting 3 min',
        nextCheck: null,
        failure: null,
        result: null,
      },
      {
        id: 't-quote',
        title: 'Build the Acme quote sheet for 200 seats',
        doneMeans: 'A sheet with 200 seats at $48k, valid to Nov 30, that opens and whose totals match.',
        state: 'working',
        where: { machine: M('Mac mini'), agent: 'Codex' },
        origin: 'asked',
        attempts: 1,
        attemptCap: 3,
        startedAt: FIXTURE_NOW - 6 * MIN,
        step: 'Filling the pricing table',
        nextCheck: null,
        failure: null,
        result: null,
      },
      {
        id: 't-compare',
        title: 'Compare three vendors’ pricing pages',
        doneMeans: 'A table of the three prices side by side.',
        state: 'working',
        where: { machine: M('Studio'), agent: 'Browser' },
        origin: 'asked',
        attempts: 1,
        attemptCap: 3,
        startedAt: FIXTURE_NOW - 2 * MIN,
        step: 'Reading page 2 of 3',
        nextCheck: null,
        failure: null,
        result: null,
      },
      {
        id: 't-aws',
        title: 'AWS invoice · due today',
        doneMeans: 'You know before it is due.',
        state: 'watching',
        where: { machine: M('Studio'), agent: 'Claude Code' },
        origin: 'asked',
        attempts: 1,
        attemptCap: 3,
        startedAt: FIXTURE_NOW - 5 * 60 * MIN,
        step: 'Invoice mail from AWS, due today',
        nextCheck: FIXTURE_NOW + 2 * 60 * MIN,
        failure: null,
        result: null,
      },
      {
        id: 't-sort',
        title: 'Sort the Downloads folder',
        doneMeans: 'Every file is in a folder.',
        state: 'done',
        where: { machine: M('This Mac'), agent: 'Claude Code' },
        origin: 'asked',
        attempts: 1,
        attemptCap: 3,
        startedAt: FIXTURE_NOW - 5 * 60 * MIN,
        step: null,
        nextCheck: null,
        failure: null,
        result: { summary: '214 files sorted', files: [], evidence: 'Downloads has no loose files' },
      },
      {
        id: 't-failed',
        title: 'Export the Q3 report',
        doneMeans: 'The report is a PDF in Documents.',
        state: 'failed',
        where: { machine: M('Mac mini'), agent: 'Codex' },
        origin: 'asked',
        attempts: 1,
        attemptCap: 3,
        startedAt: FIXTURE_NOW - 40 * MIN,
        step: null,
        nextCheck: null,
        failure: {
          code: 'session-error',
          message: 'Couldn’t finish: Mac mini is out of disk space.',
          machine: M('Mac mini'),
          agent: 'Codex',
          fix: null,
        },
        result: null,
      },
      {
        id: 't-missing',
        title: 'Summarise the vendor contracts',
        doneMeans: 'One page per contract.',
        state: 'failed',
        where: { machine: M('Mac mini'), agent: 'Codex' },
        origin: 'asked',
        attempts: 1,
        attemptCap: 3,
        startedAt: FIXTURE_NOW - 50 * MIN,
        step: null,
        nextCheck: null,
        failure: {
          code: 'agent-missing',
          message: 'Codex isn’t installed on Mac mini.',
          machine: M('Mac mini'),
          agent: 'Codex',
          fix: { id: 'install-agent:mac-mini:Codex', label: 'Install Codex on Mac mini' },
        },
        result: null,
      },
    ],
    notes: [
      {
        id: 'n-acme',
        title: 'Acme',
        kind: 'company',
        updatedAt: FIXTURE_NOW - 14 * 60 * MIN,
        lastChange: {
          id: 'c-1',
          at: FIXTURE_NOW - 14 * 60 * MIN,
          summary: 'Summary rewritten after the price was confirmed.',
          undoable: true,
        },
        lines: [
          {
            id: 'l-1',
            text: 'Renewal in progress. $48k for 200 seats, price holds for a Dec 1 start. Waiting on your reply to Dana.',
            at: FIXTURE_NOW,
            status: 'learned',
            quote: 'the $48k price holds if we start Dec 1',
            sources: [
              { id: 's1', kind: 'mail', label: 'Gmail · “Re: Acme renewal”', at: FIXTURE_NOW, gone: false },
              { id: 's2', kind: 'event', label: 'Calendar · “Acme sync”', at: FIXTURE_NOW - 13 * DAY, gone: false },
            ],
          },
          {
            id: 'l-2',
            text: 'Dana needs the revised quote by Friday',
            at: FIXTURE_NOW - 6 * DAY,
            status: 'mentioned-once',
            quote: null,
            sources: [{ id: 's3', kind: 'mail', label: 'Gmail · “Re: Acme renewal”', at: FIXTURE_NOW - 6 * DAY, gone: true }],
          },
          {
            id: 'l-3',
            text: 'Raj Patel handles IT and single sign-on',
            at: FIXTURE_NOW - 22 * DAY,
            status: 'confirmed',
            quote: null,
            sources: [],
          },
        ],
        history: [
          { id: 'c-1', at: FIXTURE_NOW - 14 * 60 * MIN, summary: 'Summary rewritten after the price was confirmed', undoable: true },
          { id: 'c-2', at: FIXTURE_NOW - 6 * DAY, summary: 'Added: Dana needs the revised quote by Friday', undoable: true },
        ],
      },
      {
        id: 'n-dana',
        title: 'Dana Lee',
        kind: 'person',
        updatedAt: FIXTURE_NOW - 14 * 60 * MIN,
        lastChange: null,
        lines: [{ id: 'd-1', text: 'Runs renewals at Acme.', at: FIXTURE_NOW - 20 * DAY, status: 'learned', quote: null, sources: [] }],
        history: [],
      },
      {
        id: 'n-about',
        title: 'About you',
        kind: 'about',
        updatedAt: FIXTURE_NOW - 30 * DAY,
        lastChange: null,
        lines: [
          {
            id: 'ab-1',
            text: 'Prefers morning calls.',
            at: FIXTURE_NOW - 30 * DAY,
            status: 'confirmed',
            quote: 'I prefer morning calls',
            sources: [],
          },
        ],
        history: [],
      },
    ],
    rules: [
      {
        id: 'r-clients',
        text: 'Client replies → tell me right away',
        kind: 'does-more',
        effect: 'tell_now',
        origin: 'learned',
        state: 'on',
        appliesTo: 'Mail from people at companies you work with',
        evidence: [{ at: FIXTURE_NOW - 12 * DAY, reaction: 'You said', item: 'when a client replies, tell me right away' }],
        useCount: 4,
        inBrief: false,
      },
      {
        id: 'r-deliveries',
        text: 'Deliveries → stay quiet',
        kind: 'quieter',
        effect: 'stay_quiet',
        origin: 'learned',
        state: 'on',
        appliesTo: 'Delivery notices from shops and carriers',
        evidence: [
          { at: FIXTURE_NOW - 19 * DAY, reaction: 'Not needed', item: 'Your Uniqlo package arrives tomorrow' },
          { at: FIXTURE_NOW - 19 * DAY, reaction: 'Not needed', item: 'Your Muji package shipped' },
        ],
        useCount: 7,
        inBrief: true,
      },
      {
        id: 'r-invoices',
        text: 'Invoices → tell me when they arrive',
        kind: 'does-more',
        effect: 'tell_now',
        origin: 'yours',
        state: 'on',
        appliesTo: 'Invoice mail',
        evidence: [],
        useCount: 2,
        inBrief: false,
      },
      {
        id: 'r-send',
        text: 'Sending email → always ask me',
        kind: 'quieter',
        effect: 'ask_first',
        origin: 'built-in',
        state: 'on',
        appliesTo: 'Every email MoMo would send',
        evidence: [],
        useCount: 0,
        inBrief: false,
      },
    ],
    problems: [],
    signals: [{ id: 'sig-1', text: 'you opened two newsletters late. One more and I will suggest moving them to the morning brief.' }],
    settings: { brief: { on: true, time: '08:00' }, quietHours: { from: '22:00', to: '08:00' }, dailyCap: 6, previews: false },
  };
}

/** A named starting point for the dev switch and the specs: the fixture view in one of the states the design draws. */
export function scenarioView(name: string | null): MomoView {
  const v = fixtureView();
  const home = (patch: Partial<MomoView['home']>): MomoView => ({ ...v, home: { ...v.home, ...patch } });
  switch (name) {
    case 'first-run':
      return {
        ...v,
        setup: { step: 'where', google: 'idle', notifications: 'unknown' },
        chat: [],
        tasks: [],
        notes: [],
        rules: [],
        signals: [],
        home: { ...v.home, sources: [] },
      };
    case 'asleep':
      return home({ state: 'asleep', stateSince: FIXTURE_NOW - 2 * 60 * MIN });
    case 'needs-update':
      return home({ state: 'needs-update', update: { have: '0.3.0', need: '0.4.0' } });
    case 'signed-out':
      return home({
        state: 'needs-sign-in',
        agentProblem: {
          kind: 'signed-out',
          agent: 'Claude Code',
          fix: { id: 'sign-in-agent:studio:Claude Code', label: 'Sign in on Studio' },
        },
      });
    case 'not-installed':
      return home({
        state: 'needs-sign-in',
        agentProblem: {
          kind: 'not-installed',
          agent: 'Claude Code and Codex',
          fix: { id: 'install-agent:studio:Claude Code', label: 'Install on Studio' },
        },
      });
    case 'move-failed':
      return home({
        state: 'moving',
        move: {
          moveId: 'm1',
          from: M('Studio'),
          to: M('Mac mini'),
          step: 'copied',
          outcome: 'failed',
          finishedAt: FIXTURE_NOW,
          failure: { cause: 'Mac mini stopped answering.', failedAt: 'copied' },
          oldMachineOffline: false,
        },
      });
    case 'move-stuck':
      return home({
        state: 'moving',
        move: {
          moveId: 'm2',
          from: M('Studio'),
          to: M('Mac mini'),
          step: 'switching',
          outcome: 'running',
          finishedAt: null,
          failure: null,
          oldMachineOffline: false,
          reclaim: {
            title: 'Run MoMo on Studio again?',
            body: 'The copy on Mac mini will be refused.',
            confirm: 'Run MoMo here again',
          },
        },
      });
    case 'empty':
      return { ...v, tasks: [], notes: [], rules: [], signals: [] };
    case 'source-gone':
      return home({ sources: v.home.sources.map((s) => (s.id === 'gmail' ? { ...s, status: 'needs-reconnect' as const } : s)) });
    default:
      return v;
  }
}
