// UI tests for native computer/browser control (PR #346 and #347): the Claude in Chrome note, the native
// cleanup strip and its priority, Codex's native app approval card, elicitation answers, and tool
// screenshots; plus the later changes to the same components (browser/desktop step narration in
// Items.tsx, MoPilot's desktop access and browser site cards in Approvals.tsx). The components and their
// pure helpers are real; app services are fixture stubs.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { importsToStub } from '../source-modules.ts';
import { window } from '../dom.ts';
import { deferred } from '../async-scenarios.ts';
import { installNativeStub } from '../ports/native.ts';
import { toolInvocation } from '../../../shared/toolInvocation.mjs';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');
// the real copy table, unless a case sets `f.copyText` for every key
const { copy: realCopy } = await import('../../../src/harness/copy.ts');

const marker = (name: string) => (props: any) => createElement('div', { 'data-marker': name, 'data-thread': props.threadId });
const f: any = {
  toolInvocation,
  HARNESS_IDS: ['codex', 'claude'],
  state: {},
  session: {},
  flags: {},
  requests: [],
  calls: [],
  tasks: false,
  copyText: null,
  useStore: (select: any) => select(f.state),
  useSession: (id: string) => {
    f.calls.push(['useSession', id]);
    return f.session;
  },
  useSessionField: (_id: string, pick: any) => pick(f.session),
  useFlag: (key: string) => !!f.flags[key],
  copy: (...a: Parameters<typeof realCopy>) => f.copyText ?? realCopy(...a),
  toastFailure: (what: string) => (e: unknown) => f.calls.push(['toastFailure', what, String(e)]),
  setPrefs: (p: any) => f.calls.push(['setPrefs', p]),
  navigate: (r: any) => f.calls.push(['navigate', r]),
  connect: () => f.calls.push(['connect']),
  resolveRequest: (id: any, result: any) => f.calls.push(['resolve', id, result]),
  interrupt: (id: string) => f.calls.push(['interrupt', id]),
  requestsOf: () => f.requests,
  sourceLabel: () => 'Codex',
  harnessInfo: (kind: string) => ({ label: ({ codex: 'Codex', claude: 'Claude Code' } as Record<string, string>)[kind] ?? kind }),
  chatHarnessLabel: () => 'Codex',
  native: {
    // NativeCleanup's Restart Codex: `f.restartFails` rejects it
    codex: { restart: () => (f.calls.push(['restartCodex']), f.restartFails ? Promise.reject(new Error('busy')) : Promise.resolve()) },
    browser: {
      claudeInChromeNote: (id: any) => {
        f.calls.push(['note', id]);
        return f.notePromise(id);
      },
      dismissClaudeInChromeNote: async () => void f.calls.push(['dismiss']),
      configure: async (c: any) => {
        f.calls.push(['configure', c]);
      },
      onChannelChanged: () => () => {},
    },
    // the shared status (src/session/nativeAvailability.ts is real here): null never answers
    availability: {
      status: () => (f.availability == null ? new Promise(() => {}) : Promise.resolve(availabilityOf(f.availability))),
      onChanged: (cb: () => void) => {
        f.availListeners.push(cb);
        return () => {};
      },
      chromeReconnect: (chatId: any) => {
        f.calls.push(['chromeReconnect', chatId]);
        return f.reconnect();
      },
    },
    shell: { openExternal: (u: string) => f.calls.push(['open', u]) },
    computer: {
      answer: async (id: string, r: any) => f.calls.push(['answer', id, r]) > 0,
      takeOver: (id: string, b: string) => f.calls.push(['takeOver', id, b]),
      handBack: (id: string, b: string) => f.calls.push(['handBack', id, b]),
      stop: (id: string) => f.calls.push(['stop', id]),
    },
  },
  ComputerActivity: marker('computer'),
  useTasksPill: () => ({ running: f.tasks ? 1 : 0, waiting: 0, live: f.tasks ? 1 : 0, finished: null }),
  pillShown: (p: any) => p.live > 0,
  StopAllConfirm: (p: any) =>
    createElement('button', { 'data-marker': 'tasks', 'data-running': String(p.running), onClick: () => p.setConfirm(false) }),
  Collapse: ({ open, children }: any) => (open ? children : null),
  ZoomableImage: (p: any) => createElement('img', { className: p.className, src: p.src, alt: p.alt }),
  CodeBlock: ({ code, lang }: any) => createElement('pre', { 'data-lang': lang }, code),
  // icons show which one a row picked
  MousePointerClick: () => createElement('i', { 'data-icon': 'mouse' }),
  Globe: () => createElement('i', { 'data-icon': 'globe' }),
  Plug: () => createElement('i', { 'data-icon': 'plug' }),
  SquareTerminal: () => createElement('i', { 'data-icon': 'terminal' }),
  Info: () => createElement('i', { 'data-icon': 'info' }),
  // step groups: every step is visible, and the running row shows its label
  visibleSteps: (steps: any[]) => steps,
  prettyCommand: (c: any) => String(c),
  claudeActivityParts: (step: any) => ({ verb: step ? `Claude: ${step.kind}` : 'Claude is thinking' }),
  activityText: (l: any) => l.verb,
  activityRowText: (l: any) => l.verb,
  markActivity: () => 'think',
  // a label shows at once: the dwell is lib/minDwell's own (its own tests)
  useMinDwell: (v: any) => v,
  // what the row opens to shows only while it is open, as its Collapse does
  ClaudeActivity: (p: any) =>
    createElement(
      'div',
      { 'data-marker': 'claude-activity', 'data-open': String(!!p.open), onClick: p.onToggle },
      p.label,
      p.open ? p.children : null,
    ),
  RunningCommand: (p: any) => createElement('div', { 'data-marker': 'running-command' }, p.label),
  // the approval card's options menu: its items are buttons, always shown
  useAnchor: () => ({ ref: null, anchor: null, open: false, toggle: () => {}, close: () => {} }),
  Menu: (p: any) => createElement('div', { 'data-marker': 'menu' }, p.children),
  // src/session/open.ts: the link helpers report a failure themselves (tests/open.test.ts)
  openLink: (u: string) => f.calls.push(['open', u]),
  MenuItem: (p: any) => createElement('button', { 'data-marker': 'menu-item', onClick: p.onSelect }, p.children),
  // Codex's requirements, for "Allow for all sites"
  requirements: async () => ({ requirements: null }),
  codexApi: {
    configRequirementsRead: () => {
      f.calls.push(['codex', 'configRequirementsRead']);
      return f.requirements();
    },
  },
};
// The components and the plain TypeScript helpers they use are real; every other module the components
// import is mocked with the names they import, taken from the fixture (or inert).
const real = [
  'src/components/browser/ClaudeInChromeNote.tsx',
  'src/components/thread/NativeCleanup.tsx',
  'src/components/thread/ChromeLinkNotice.tsx',
  'src/components/thread/StatusStrip.tsx',
  'src/components/thread/AppControlStrip.tsx',
  'src/components/thread/Approvals.tsx',
  'src/components/thread/approvals/shared.tsx',
  'src/components/thread/approvals/hostCards.tsx',
  'src/components/thread/approvals/confirmAllow.tsx',
  'src/components/thread/approvals/HostAskCard.tsx',
  'src/components/thread/approvals/requestCards.tsx',
  'src/components/thread/approvals/elicitationCards.tsx',
  'src/components/thread/approvals/browserCards.tsx',
  'src/components/thread/approvals/toolCards.tsx',
  'src/components/thread/Items.tsx',
  'src/components/thread/items/stepModel.ts',
  // the shimmering label's span (Shimmer in presentation.tsx renders through it)
  'src/components/ui/ShimmerBand.tsx',
  'src/components/thread/items/presentation.tsx',
  'src/components/thread/items/StepGroups.tsx',
  'src/components/thread/items/StepRow.tsx',
  'src/components/thread/items/StepSummary.tsx',
  'src/components/thread/items/output.tsx',
  'src/components/thread/items/BlockItems.tsx',
  'src/components/thread/items/TodoSteps.tsx',
  'src/components/agents/AgentChatContext.ts',
  // the traits nativeAvailability reads (which harness runs Claude in Chrome itself)
  'src/harness/family.ts',
];
const realLibs = new Set(
  [
    // Resolve real approval origin before the UI's label service boundary.
    'shared/approvalOrigin.mjs',
    'src/session/nativeAvailability.ts',
    'src/lib/statusStrip.ts',
    'src/harness/elicitation.ts',
    'src/harness/chromeApproval.ts',
    'src/lib/toolOutput.ts',
    'src/lib/agentNarration.ts',
    // the short words a step group's summary is made of
    'src/lib/agentNarration/verbs.ts',
    // a tool's name without MoPilot's server nonce, and its own tools' lines (#2280)
    'src/lib/ownToolLines.ts',
    'src/lib/scheduledTaskCall.ts',
    // what a step and the strips call an app (its display name)
    'src/lib/appNames.ts',
    'src/components/thread/approvalLogic.ts',
    'src/lib/listKeys.ts',
    // the cards' window key listeners
    'src/lib/effects.ts',
    // errorText: what an error says to the user (without Electron's IPC wrapper)
    'src/lib/ignored.ts',
    // the native port, real: the fixture's bridge is installed in it below
    'src/lib/native.ts',
    // the one "Done, continue" label
    'src/lib/doneContinue.ts',
    // pluralize: the narration's counted words (src/lib/agentNarration)
    'src/lib/format.ts',
    // which steps are waits, and when each step ran (the running line's wait countdown)
    'src/lib/waitStep.ts',
    'src/components/thread/items/turnTiming.ts',
  ].map((p) => new URL('../../../' + p, import.meta.url).href),
);
for (const [file, names] of importsToStub(
  real.map((p) => new URL('../../../' + p, import.meta.url)),
  (module) => realLibs.has(module.href),
))
  mock.module(file, { namedExports: Object.fromEntries([...names].map((n) => [n, f[n] ?? (() => null)])) });
// the fixture's bridge, in the port the components read (src/lib/native.ts)
installNativeStub(f.native);
const { ClaudeInChromeNote } = await import('../../../src/components/browser/ClaudeInChromeNote.tsx');
const { NativeCleanup } = await import('../../../src/components/thread/NativeCleanup.tsx');
const { ChromeLinkNotice } = await import('../../../src/components/thread/ChromeLinkNotice.tsx');
const { StatusStrip } = await import('../../../src/components/thread/StatusStrip.tsx');
const { Approvals } = await import('../../../src/components/thread/Approvals.tsx');
const { StepRow } = await import('../../../src/components/thread/items/StepRow.tsx');
const { StepGroup } = await import('../../../src/components/thread/Items.tsx');
const { summarizeSteps } = await import('../../../src/components/thread/items/stepModel.ts');
const { activeStepLabel } = await import('../../../src/components/thread/items/presentation.tsx');

async function mount(element: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => {
    root.render(element);
  });
  return {
    host,
    render: async (next: any) =>
      act(async () => {
        root.render(next);
      }),
    button: (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as any,
    click: async (el: any) => {
      assert.ok(el);
      await act(async () => {
        el.click();
        await Promise.resolve();
      });
    },
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

function availabilityOf(claudeChrome: string) {
  const surface = (state: string) => ({ state, label: state, detail: null, actions: [] });
  return {
    platform: 'darwin',
    at: 1,
    // MoPilot's own extension serves Claude without Claude in Chrome (main's chromeTools)
    chromeTools: !!f.chromeTools,
    harnesses: [
      { harness: 'codex', label: 'Codex', chrome: surface('native'), computer: surface('native') },
      { harness: 'claude', label: 'Claude Code', chrome: surface(claudeChrome), computer: surface('mopilot') },
    ],
  };
}

function nativeRequest(params: any = {}, meta: any = {}) {
  return {
    id: 'req-1',
    method: 'mcpServer/elicitation/request',
    threadId: 'chat',
    params: {
      serverName: 'computer-use-server',
      mode: 'form',
      message: '',
      requestedSchema: { type: 'object', properties: {} },
      ...params,
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        connector_id: 'computer-use',
        tool_params: { app: 'Safari' },
        persist: ['session', 'always'],
        ...meta,
      },
    },
  };
}
async function approvals(req: any) {
  f.requests = [req];
  f.session = { approvals: [] };
  f.state = { segments: {}, runtime: {} };
  f.calls = [];
  return mount(createElement(Approvals, { threadId: 'chat', cwd: '/project' }));
}
const resolved = () => f.calls.filter((c: any[]) => c[0] === 'resolve').map((c: any[]) => c.slice(1));
const footer = (host: any) =>
  [...host.querySelectorAll('.approval-footer button')].map((b: any) => ({ text: b.textContent, cls: b.className }));

function trusted<T extends Event>(e: T): T {
  Object.defineProperty(e, 'isTrusted', { value: true });
  return e;
}
const press = (key: string, target: any = window, o: any = {}) =>
  act(async () => {
    target.dispatchEvent(trusted(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o }) as any));
  });
const personClick = (el: any) =>
  act(async () => {
    el.dispatchEvent(trusted(new window.MouseEvent('click', { bubbles: true, cancelable: true }) as any));
  });

export {
  React,
  act,
  createElement,
  createRoot,
  f,
  ClaudeInChromeNote,
  NativeCleanup,
  ChromeLinkNotice,
  StatusStrip,
  Approvals,
  StepRow,
  StepGroup,
  summarizeSteps,
  activeStepLabel,
  mount,
  deferred,
  flush,
  availabilityOf,
  nativeRequest,
  approvals,
  resolved,
  footer,
  trusted,
  press,
  personClick,
  window,
};
