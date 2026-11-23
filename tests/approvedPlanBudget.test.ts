// A real accepted-plan dispatch, rather than model text, owns the fourth independent suggestion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestration, SESSION_BACKGROUND } from './support/orchestration-harness.ts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { beforePlanDispatch } = require('../electron/session/orchestration/planAcceptance.cjs');

test('an accepted plan permits four suggestions through the public tool; ordinary turns retain three', async () => {
  for (const accepted of [false, true]) {
    const h = orchestration();
    h.userTurn();
    const delivery = {
      chatId: 'top',
      kind: 'turn',
      ref: h.controller.ref('top'),
      item: {
        id: 'turn1',
        text: 'Implement the plan.',
        opts: { human: true, plan: false },
        ...(accepted ? { planApproval: { native: 'top', itemId: 'plan1' } } : {}),
      },
    };
    h.orch.dispatching(delivery);
    // createOrchestration installs this main-owned guard immediately after dispatch bookkeeping.
    beforePlanDispatch(h.orch, delivery);
    for (let i = 0; i < 3; i++)
      await h.orch.start('top', {
        initiation: 'own_initiative',
        title: `Independent ${i}`,
        prompt: `Do independent task ${i}`,
        background: SESSION_BACKGROUND,
      });
    const fourth = () =>
      h.orch.start('top', {
        initiation: 'own_initiative',
        title: 'Independent 4',
        prompt: 'Do independent task 4',
        background: SESSION_BACKGROUND,
      });
    if (accepted) {
      assert.equal((await fourth()).status, 'proposed');
      await assert.rejects(
        () =>
          h.orch.start('top', {
            initiation: 'own_initiative',
            title: 'Independent 5',
            prompt: 'Do fifth task',
            background: SESSION_BACKGROUND,
          }),
        { code: 'proposal_limit' },
      );
    } else await assert.rejects(fourth, { code: 'proposal_limit' });
  }
});
