// The shared plan button supplies its displayed item identity for main verification on every harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, trustedClick } from './support/thread-kit.ts';

const sent: any[] = [];
let planning = true;
mockStore({
  sendMessage: async (...args: any[]) => {
    sent.push(args);
    return true;
  },
});
autoMock('src/store/session/useSession.ts', 'session', {
  sessionOf: () => ({ plan: planning }),
  setSession: async (_id: string, value: any) => {
    planning = value.plan;
  },
});
autoMock('src/components/thread/PlanCard.tsx', 'plan', { PlanCard: stubComponent('PlanCard') });
autoMock('src/components/thread/ReviewCard.tsx', 'review', { ReviewCard: stubComponent('ReviewCard') });
autoMock('src/components/thread/EditedFilesCard.tsx', 'files', { EditedFilesCard: stubComponent('EditedFilesCard') });
const { TurnCardView } = await import('../src/components/thread/view/TurnCards.tsx');

test('implementing the displayed plan sends a typed button intent, never a model-issued approval boolean', async () => {
  for (const threadId of ['codex-chat', 'claude-chat', 'acp-chat']) {
    const item = { type: 'plan', id: `plan-${threadId}`, text: `Plan for ${threadId}` };
    const v = await render(
      h(TurnCardView, { card: { kind: 'plan', item } as any, cwd: '/repo', threadId, canImplement: true, running: false }),
    );
    await trustedClick(v.$('button')!);
    assert.deepEqual(sent.at(-1), [
      threadId,
      'Implement the plan.',
      [],
      {
        plan: false,
        human: true,
        acceptedPlan: { itemId: item.id, text: item.text },
      },
    ]);
    assert.equal(planning, false);
    await v.unmount();
  }
});
