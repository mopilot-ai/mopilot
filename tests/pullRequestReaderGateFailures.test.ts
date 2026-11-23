// src/session/pullRequestReader.ts viewer and gateStatus when gh fails or answers nothing usable: no login (so no review
// asked of the user) and no gate words (so the row shows no robot step), never an error in the row. A failed statuses
// read marks the gate unread, so the inbox keeps the PR's last answer (prLastAnswer.ts) instead of moving it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
import { GATE_STATUS } from '../src/lib/pullRequestIndicator.ts';

const gate = { __typename: 'StatusContext', context: GATE_STATUS, state: 'PENDING' };
/** what gh answers: the login and each head's statuses, by head */
const answers: Record<string, { ok: boolean; stdout: string }> = {
  user: { ok: false, stdout: '' },
  h1: { ok: true, stdout: '' },
  h2: { ok: false, stdout: '' },
  h3: { ok: true, stdout: '"words"' },
};
installNativeStub({
  git: {
    run: async () => ({ ok: true, stdout: '' }),
    gh: async (_cwd: string, args: string[]) => {
      if (args[1] === 'user') return answers.user;
      if (args[0] === 'api') return answers[args[1].split('/')[4]];
      const url = args.at(-1)!;
      return {
        ok: true,
        stdout: JSON.stringify({
          url,
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          headRefOid: `h${url.split('/').at(-1)}`,
          statusCheckRollup: [gate],
          reviewRequests: [{ login: '' }],
        }),
      };
    },
  },
  prMonitor: { snapshot: async () => null },
});
stubStore({ nativeOf: (id: string) => id, useStore: Object.assign(() => null, { getState: () => ({ home: '/home', runtime: {} }) }) });

test('a failed or empty login and unusable gate answers leave the PR without a review or a robot step', async () => {
  const { readPullRequest } = await import('../src/session/pullRequestReader.ts');
  for (const n of [1, 2, 3]) {
    const pr = await readPullRequest.status(`https://github.com/o/r/pull/${n}`);
    assert.equal(pr.state, 'open', JSON.stringify(pr));
    assert.equal(pr.details?.gate, undefined, `PR ${n}`);
    assert.equal(pr.details?.review, undefined, `PR ${n}`);
    // only gh failing is "unread"; an empty or unusable answer is no status
    assert.equal(pr.details?.gateUnread, n === 2 ? true : undefined, `PR ${n}`);
  }
});
