// What a chat shows after computer use refused an app (#1724), against a fake store: the transcript line (a control
// status note), the working-in card for the refused app (its name, "Refused", no live view, no bring to front) and the
// composer's suggestion, which never names the refused app.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, resetStore, setStore, settle, trustedClick, native } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/thread/ScheduledTaskCard.tsx', 'schedCard', { ScheduledTaskCard: stubComponent('ScheduledTaskCard') });
autoMock('src/components/tasks/TaskEventCard.tsx', 'taskEvent', { TaskEventCard: stubComponent('TaskEventCard') });
const { useSessions } = await import('../src/store/session/useSession.ts');
const { WorkingInStack } = await import('../src/components/thread/WorkingIn.tsx');
const { useNextStep } = await import('../src/components/composer/useNextStep.ts');
const { BlockItem } = await import('../src/components/thread/Items.tsx');

const T = 't1';
const cua = (code: string, status = 'completed') => ({
  type: 'mcpToolCall',
  server: 'cua_repl',
  tool: 'js',
  arguments: { code },
  status,
  result: { content: [] },
});
const NOTE = {
  id: 'control-1',
  kind: 'control',
  text: "Computer use can't control MoPilot itself.",
  refused: { app: 'ai.mopilot.code', name: 'MoPilot' },
  turnId: 'turn1',
  turn: 0,
  at: 1,
};
const show = (notes: any[] | undefined, running = false) =>
  setStore({
    runtime: {
      [T]: {
        loaded: true,
        activeTurnId: running ? 'turn1' : null,
        turns: [
          {
            id: 'turn1',
            status: running ? 'inProgress' : 'interrupted',
            items: [cua("const m = await cua.getApp('ai.mopilot.code');", 'failed')],
          },
        ],
      },
    },
    chatNotes: notes ? { [T]: notes } : {},
  });

let looked: string[] = [];
let fronted: string[] = [];
beforeEach(() => {
  resetStore();
  useSessions.setState({ sessions: {} });
  looked = [];
  fronted = [];
  native.computer = {
    workingThumb: async (_c: string, app: string) => (looked.push(`thumb:${app}`), { thumbnail: 'data:image/jpeg;base64,eA==' }),
    appIcon: async (app: string) => (looked.push(`icon:${app}`), 'data:image/png;base64,eA=='),
    bringToFront: async (app: string) => (fronted.push(app), true),
  };
});

test('the working-in card names the refused app, says Refused, and never looks at it or brings it forward', async () => {
  show([NOTE]);
  const v = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  assert.equal(v.$('.working-in-card')!.getAttribute('data-status'), 'refused');
  const card = v.$('.working-in-main') as HTMLButtonElement;
  assert.equal(v.$('.working-in-app')!.textContent, 'MoPilot');
  assert.equal(v.$('.working-in-step')!.textContent, 'Refused');
  assert.equal(card.getAttribute('aria-label'), 'Refused MoPilot: Refused');
  assert.equal(card.title, 'Refused MoPilot');
  assert.equal(card.disabled, true);
  // no way to open its live view or bring it forward
  assert.equal(card.getAttribute('aria-expanded'), null);
  assert.equal(v.$('.working-in-front'), null);
  assert.equal(v.$('img.working-in-thumb'), null);
  assert.ok(v.$('.working-in-badge.failed'));
  await trustedClick(card);
  assert.deepEqual(looked, [], 'no icon, thumbnail or capture of MoPilot');
  assert.deepEqual(fronted, []);
  assert.equal(v.$('.working-in-live'), null);
  // the note arriving later (main writes it as it stops the turn) turns an ordinary card into the refused one
  await settle(() => show(undefined));
  const plain = await render(h(WorkingInStack, { threadId: T }));
  await settle();
  // without it, the card's own name lookup (src/lib/appNames.ts) never shows the bundle id
  assert.equal(plain.$('.working-in-app')!.textContent, 'App');
  await settle(() => show([NOTE]));
  assert.equal(plain.$('.working-in-card')!.getAttribute('data-status'), 'refused');
  await v.unmount();
  await plain.unmount();
});

test('the composer suggests nothing for a refused app; without the note the old suggestion, and none while it runs', async () => {
  let seen: (string | null)[] = [];
  const Probe = () => {
    seen.push(useNextStep(T));
    return null;
  };
  show([NOTE]);
  const v = await render(h(Probe));
  assert.equal(seen.at(-1), null);
  await settle(() => show(undefined));
  assert.equal(seen.at(-1), 'Check ai.mopilot.code again and tell me what changed');
  await settle(() => show(undefined, true));
  assert.equal(seen.at(-1), null);
  await v.unmount();
  seen = [];
  const none = await render(h(() => (seen.push(useNextStep(null)), null)));
  assert.deepEqual(seen, [null]);
  await none.unmount();
});

test('the refusal line in the transcript: a control status note with its own icon', async () => {
  const v = await render(
    h(BlockItem, { item: { type: 'statusNote', id: 'control-1', kind: 'control', text: NOTE.text } as any, cwd: '/w' }),
  );
  const row = v.host.querySelector('.status-note.control')!;
  assert.equal(row.querySelector('.step-text')!.textContent, "Computer use can't control MoPilot itself.");
  assert.ok(row.querySelector('.step-icon svg.lucide-ban'), 'the refusal icon');
  await v.unmount();
});
