// Secrets never leave the Mac in shared usage data (the server runs the same scrubber again).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scrub, scrubDeep, redactEnv } = require('../shared/scrub.cjs');
const { AUTH_IDENTITY_ENV } = require('../electron/platform/env.cjs');

const fake = (prefix: string, n = 40) => prefix + 'A1b2C3d4E5'.repeat(Math.ceil(n / 10)).slice(0, n);

test('provider and platform keys', () => {
  for (const [secret, label] of [
    [fake('sk-ant-api03-'), 'anthropic-key'],
    [fake('sk-proj-'), 'openai-key'],
    [fake('sk-'), 'openai-key'],
    [fake('mpk_'), 'mopilot-key'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws-key-id'],
    [fake('ghp_', 36), 'github-token'],
    [fake('github_pat_', 60), 'github-token'],
    [fake('xoxb-', 30), 'slack-token'],
    [fake('sk_live_', 24), 'stripe-key'],
    ['AIza' + 'B'.repeat(35), 'google-key'],
  ]) {
    const out = scrub(`use ${secret} here`);
    assert.ok(!out.includes(secret), `${label} leaked: ${out}`);
    assert.match(out, new RegExp(`\\[REDACTED:${label}\\]`));
  }
});

test('JWTs, bearer headers, URL credentials, PEM blocks', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.ok(!scrub(`token ${jwt}`).includes(jwt));
  assert.equal(scrub('Authorization: Bearer abcdefghijklmnop1234'), 'Authorization: Bearer [REDACTED:token]');
  assert.equal(scrub('postgres://admin:hunter22@db.example.com/x'), 'postgres://[REDACTED:credentials]@db.example.com/x');
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
  assert.equal(scrub(`k=${pem}`).includes('MIIEow'), false);
});

test('env and config assignments', () => {
  assert.equal(scrub('DATABASE_PASSWORD=sup3rs3cret'), 'DATABASE_PASSWORD=[REDACTED:secret]');
  assert.equal(scrub('"client_secret": "abcdef123456"'), '"client_secret": "[REDACTED:secret]"');
  assert.equal(scrub('api_key: zzzzzzzzzz'), 'api_key: [REDACTED:secret]');
  // ordinary prose survives
  assert.equal(scrub('Fix the token refresh bug in auth.ts'), 'Fix the token refresh bug in auth.ts');
});

test('emails and home paths', () => {
  assert.equal(scrub('mail jane.doe@example.com', {}), 'mail <email>');
  assert.equal(scrub('open /Users/jane/Projects/app/src', { home: '/Users/jane' }), 'open ~/Projects/app/src');
  assert.equal(scrub('see /Users/bob/x'), 'see /Users/<user>/x');
});

test('Windows home folders: a user name is never uploaded, however the path is written', () => {
  // a plain path, another drive and case, JSON-escaped and a Rust debug print (doubled backslashes)
  assert.equal(scrub('open C:\\Users\\Alice\\proj\\a.ts failed'), 'open C:\\Users\\<user>\\proj\\a.ts failed');
  assert.equal(scrub('d:\\users\\bob.smith\\x'), 'd:\\Users\\<user>\\x');
  assert.equal(scrub('{"cwd":"C:\\\\Users\\\\Alice\\\\repo"}'), '{"cwd":"C:\\\\Users\\\\<user>\\\\repo"}');
  assert.equal(scrub('path: "C:\\\\Users\\\\Alice"'), 'path: "C:\\\\Users\\\\<user>"');
  // forward slashes were already covered; a folder merely named Users elsewhere is left alone
  assert.equal(scrub('C:/Users/Alice/x'), 'C:/Users/<user>/x');
  assert.equal(scrub('D:\\Projects\\Users\\list.ts'), 'D:\\Projects\\Users\\list.ts');
});

test('long unbroken words scrub in linear time and still redact what follows them', () => {
  // Each of these took seconds at 64 KB when a rule's run before `://`, a keyword or `@` was unbounded (quadratic).
  const n = 64 * 1024;
  const words = ['q'.repeat(n), 'a.'.repeat(n / 2), 'eyJ'.repeat(n / 3), 'token'.repeat(n / 5), 'a://u:'.repeat(n / 6)];
  const started = Date.now();
  for (const w of words) assert.equal(scrub(w).length > 0, true);
  // the bounded scans cost ~0.1 s for all five; the unbounded ones took over 30 s
  assert.ok(Date.now() - started < 5000, `scrubbing ${words.length} long words took ${Date.now() - started} ms`);

  const long = 'x'.repeat(n);
  assert.equal(scrub(`${long} DATABASE_PASSWORD=sup3rs3cret`), `${long} DATABASE_PASSWORD=[REDACTED:secret]`);
  assert.equal(scrub(`${long} jane.doe@example.com`), `${long} <email>`);
  assert.equal(scrub(`${long} postgres://admin:hunter22@db.example.com`), `${long} postgres://[REDACTED:credentials]@db.example.com`);
  // a long password in a URL is still redacted (only the scheme's run is bounded)
  assert.equal(scrub(`https://oauth2:${'p'.repeat(400)}@git.example.com`), 'https://[REDACTED:credentials]@git.example.com');
  // a key name of any length before its keyword is still a secret (its start is left out of the match)
  const key = `${'A'.repeat(300)}_TOKEN`;
  assert.equal(scrub(`${key}=abcdefgh`), `${key}=[REDACTED:secret]`);
});

test('scrubDeep walks objects and truncates', () => {
  const out = scrubDeep({ a: [fake('sk-ant-')], b: { c: 'x'.repeat(50) }, n: 3 }, {}, 10);
  assert.match(out.a[0], /REDACTED/);
  assert.match(out.b.c, /truncated 40 chars/);
  assert.equal(out.n, 3);
});

test('the env scrub list covers auth and parent-session identity only', () => {
  for (const k of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_AGENT_SDK_VERSION',
    // a host's account for the token it passes (Claude Desktop), #1294
    'CLAUDE_CODE_ACCOUNT_UUID',
    'CLAUDE_CODE_USER_EMAIL',
    'CLAUDE_CODE_ORGANIZATION_UUID',
  ])
    assert.ok(AUTH_IDENTITY_ENV.test(k), k);
  for (const k of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'CLAUDE_CODE_EFFORT_LEVEL',
    'CLAUDE_CONFIG_DIR',
    'DISABLE_TELEMETRY',
    'HTTPS_PROXY',
    'PATH',
  ])
    assert.ok(!AUTH_IDENTITY_ENV.test(k), k);
});

test('redactEnv hides secrets and paths in diagnostics', () => {
  const out = redactEnv({
    ANTHROPIC_API_KEY: 'whatever-value',
    ANTHROPIC_BASE_URL: 'https://gw.example.com',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
    HOME: '/Users/jane',
  });
  assert.equal(out.ANTHROPIC_API_KEY, '[REDACTED:secret]');
  assert.equal(out.ANTHROPIC_BASE_URL, '[REDACTED:secret]');
  assert.equal(out.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '64000');
  assert.equal(out.HOME, '/Users/<user>');
});
