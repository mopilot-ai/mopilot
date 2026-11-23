// Which login Claude Code holds on a machine, as the CLI's own record says (#4908): the account's display name and plan, so the app can show which login runs there. Never a token, an address or an id.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeLoginRecord, reportedHarness } from '../host/src/harnessState.mjs';
import { agentsOf } from '../shared/host/agentReadiness.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-login-record-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const write = (dir: string, doc: unknown) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
  return dir;
};
const ACCOUNT = {
  oauthAccount: {
    displayName: 'Meggie',
    fullName: 'Meggie R',
    emailAddress: 'someone@example.test',
    accountUuid: 'acc-1',
    organizationUuid: 'org-1',
    organizationType: 'claude_max',
    planDisplayName: 'Ultra',
    organizationRateLimitTier: 'default_claude_max_20x',
  },
};

test('the record names the account and its plan, and carries nothing that identifies or authenticates it', () => {
  const home = write(path.join(base, 'a'), ACCOUNT);
  assert.deepEqual(claudeLoginRecord({ env: { HOME: home } }), { name: 'Meggie', plan: 'Ultra' });
  // the plan falls back to the organization's type, the name to the full name
  const bare = write(path.join(base, 'b'), { oauthAccount: { fullName: 'Meggie R', organizationType: 'claude_max' } });
  assert.deepEqual(claudeLoginRecord({ env: { HOME: bare } }), { name: 'Meggie R', plan: 'claude_max' });
  // an account with a plan and no name still says which plan, and one with neither says nothing
  assert.deepEqual(claudeLoginRecord({ env: { HOME: write(path.join(base, 'c'), { oauthAccount: { planDisplayName: 'Pro' } }) } }), {
    plan: 'Pro',
  });
  // and one with a name and no plan says only the name
  assert.deepEqual(claudeLoginRecord({ env: { HOME: write(path.join(base, 'n'), { oauthAccount: { displayName: 'Solo' } }) } }), {
    name: 'Solo',
  });
  // a blank name falls back to the full name
  assert.deepEqual(
    claudeLoginRecord({ env: { HOME: write(path.join(base, 'o'), { oauthAccount: { displayName: '  ', fullName: 'Full' } }) } }),
    {
      name: 'Full',
    },
  );
  assert.equal(claudeLoginRecord({ env: { HOME: write(path.join(base, 'd'), { oauthAccount: {} }) } }), null);
  // the CLI's own config folder wins over the home folder, as the CLI reads it
  const configured = write(path.join(base, 'e'), { oauthAccount: { displayName: 'Other', planDisplayName: 'Max' } });
  assert.deepEqual(claudeLoginRecord({ env: { HOME: home, CLAUDE_CONFIG_DIR: configured } }), { name: 'Other', plan: 'Max' });
});

test('no record, an unreadable one, odd values and long text give nothing or a clipped line, never an error', () => {
  assert.equal(claudeLoginRecord({ env: { HOME: path.join(base, 'nowhere') } }), null);
  assert.equal(claudeLoginRecord({ env: {}, home: '' }), null, 'no home to look in');
  // with no folder named the CLI's own home is where it looks (a file there that is not a record says nothing)
  assert.equal(claudeLoginRecord({ env: {}, home: path.join(base, 'k') }), null);
  assert.equal(claudeLoginRecord({ env: { HOME: write(path.join(base, 'f'), '{ not json') } }), null);
  assert.equal(claudeLoginRecord({ env: { HOME: write(path.join(base, 'g'), { oauthAccount: 'x' }) } }), null);
  assert.equal(
    claudeLoginRecord({ env: { HOME: write(path.join(base, 'h'), { oauthAccount: { displayName: 7, planDisplayName: ['x'] } }) } }),
    null,
  );
  const long = claudeLoginRecord({
    env: { HOME: write(path.join(base, 'i'), { oauthAccount: { displayName: 'N'.repeat(300), planDisplayName: 'P'.repeat(300) } }) },
  });
  assert.deepEqual([long?.name?.length, long?.plan?.length], [60, 60]);
});

test('Claude Code’s row on a Host carries it, no other agent’s does, and the machine’s agent row passes it on', async () => {
  const home = write(path.join(base, 'j'), ACCOUNT);
  const io = {
    codex: { models: async () => [] },
    sessions: { modelsOf: () => [] },
    leases: { has: () => false },
    env: { HOME: home },
  } as any;
  const claude: any = await reportedHarness({ id: 'claude', detected: true, signedIn: true }, io);
  assert.deepEqual(claude.loginAccount, { name: 'Meggie', plan: 'Ultra' });
  assert.equal('loginAccount' in (await reportedHarness({ id: 'codex', detected: true, signedIn: true }, io)), false);
  // a Claude Code that is not installed has no login to name
  assert.equal('loginAccount' in (await reportedHarness({ id: 'claude', detected: false, signedIn: false }, io)), false);
  const [agent] = agentsOf([claude], 'mini');
  assert.deepEqual(agent.loginAccount, { name: 'Meggie', plan: 'Ultra' });
  assert.equal('loginAccount' in agentsOf([{ id: 'claude', detected: true, signedIn: true }], 'mini')[0], false, 'an older Host says none');
});
