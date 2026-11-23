// Seeds two ChatGPT accounts for the fake Codex: the CLI's own login (first@example.test) and one added account with its own home.
import fs from 'node:fs';
import path from 'node:path';
import type { Dirs } from './app';

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
function chatgptLogin(home: string, email: string, accountId: string) {
  fs.mkdirSync(home, { recursive: true });
  const auth = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' } };
  const tokens = {
    access_token: jwt({ ...auth, exp: 4e9 }),
    id_token: jwt({ ...auth, email }),
    refresh_token: 'fake',
    account_id: accountId,
  };
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens }));
}

/** The CLI's own ChatGPT login alone, as a real sign-in leaves it in auth.json (the pool then lists it as "default"). */
export function codexCliLogin(d: Dirs) {
  chatgptLogin(d.codexHome, 'fake-user@example.test', 'acct-fake');
}

/** @param second the added account's status in accounts.json ('expired': its sign-in lapsed earlier) */
export function twoCodexAccounts(d: Dirs, second: 'ok' | 'expired' = 'ok') {
  chatgptLogin(d.codexHome, 'first@example.test', 'acct-first');
  chatgptLogin(path.join(d.userData, 'accounts', 'second'), 'second@example.test', 'acct-second');
  const account = {
    id: 'second',
    kind: 'chatgpt',
    email: 'second@example.test',
    planType: 'plus',
    chatgptAccountId: 'acct-second',
    status: second,
    addedAt: 1,
  };
  fs.writeFileSync(path.join(d.userData, 'accounts.json'), JSON.stringify({ active: 'default', accounts: [account] }));
}
