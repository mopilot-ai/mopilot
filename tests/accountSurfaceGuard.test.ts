// Guard for issue #1292: the account surfaces (Settings → Accounts & billing, a harness page's account card and
// All harnesses, the profile menu, the harness/model picker) read every account's status, name, plan and usage
// from the one account view (src/harness/accountView.ts, useAccountView.ts, useCreditsView.ts). None of them may
// derive those again: no account deriver imported, no raw usage or credit field read, no status wording of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const GUARDS = ['src/components/'];

const root = new URL('../', import.meta.url).pathname;

/** The surfaces, as folders (every .ts/.tsx file in them) and single files. */
const SURFACES = [
  'src/components/accounts',
  'src/components/harnessPicker',
  'src/components/harness/Overview.tsx',
  'src/components/harness/AllHarnesses.tsx',
  'src/components/harness/HarnessRows.tsx',
  'src/components/sidebar/SidebarFooter.tsx',
  'src/components/pages/MoPilotSettings.tsx',
];

const files = (rel: string): string[] =>
  statSync(path.join(root, rel)).isDirectory()
    ? readdirSync(path.join(root, rel))
        .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
        .map((f) => `${rel}/${f}`)
    : [rel];

/** What derives an account's status, name, plan or usage: only the account view may call these. */
const DERIVERS = [
  'accountStatusText',
  'accountLimitText',
  'accountName',
  'accountSummary',
  'accountSummaryParts',
  'profileAccountMenu',
  'pickerUsageSummary',
  'rowAccountInfo',
  'planName',
  'claudePlanLabel',
  'managedWindows',
  'formatCredits',
  'stateLabelOf',
];

/** Raw store fields an account's usage, plan or credits come from. */
const RAW_FIELDS = [/\bclaudeUsage\b/, /\.limits\b/, /\bbalanceMicros\b/, /\bplanType\b/];

/** Status wording that belongs to the account view alone. */
const WORDS = [
  'Checking…',
  'Signed out',
  'Not signed in',
  'Starts on first use',
  'Sign-in expired',
  'Limit reached',
  'Billed per token',
  'Managed by',
  'Usage unknown',
];

/** The source without its comments, so a comment may still name what it is about. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** Every way a file breaks the rule, as "file: what". */
export function violations(rel: string, src: string): string[] {
  const body = code(src);
  const found: string[] = [];
  for (const name of DERIVERS)
    if (new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(body) || new RegExp(`\\b${name}\\(`).test(body))
      found.push(`${rel}: derives with ${name}`);
  for (const field of RAW_FIELDS) if (field.test(body)) found.push(`${rel}: reads ${field.source.replace(/\\b|\\/g, '')} itself`);
  // the word as a whole string or JSX text, or a status line it starts ("Limit reached · …"); a sentence that only
  // begins with it (a tooltip's "Billed per token to your API key.") is prose, not a status
  for (const word of WORDS)
    if (new RegExp(`['"\`>]${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['"\`<]| ·| \\{)`).test(body))
      found.push(`${rel}: says "${word}" itself`);
  return found;
}

test('the account surfaces read status, name, plan and usage only from the account view', () => {
  const all = SURFACES.flatMap(files);
  assert.ok(all.length > 10, 'the surfaces are found');
  const found = all.flatMap((rel) => violations(rel, readFileSync(path.join(root, rel), 'utf8')));
  assert.deepEqual(found, [], 'use harness/useAccountView.ts (or accountView.ts) instead');
});

test('the guard catches each way a surface could derive account state again', () => {
  assert.deepEqual(violations('x.tsx', "import { accountName } from '../harness/accounts';"), ['x.tsx: derives with accountName']);
  assert.deepEqual(violations('x.tsx', 'const t = accountStatusText(a);'), ['x.tsx: derives with accountStatusText']);
  assert.deepEqual(violations('x.tsx', 'const u = useStore((s) => s.claudeUsage);'), ['x.tsx: reads claudeUsage itself']);
  assert.deepEqual(violations('x.tsx', 'const w = a.limits;'), ['x.tsx: reads .limits itself']);
  assert.deepEqual(violations('x.tsx', 'const b = mp.balanceMicros;'), ['x.tsx: reads balanceMicros itself']);
  assert.deepEqual(violations('x.tsx', "const p = a.planType ?? 'Free';"), ['x.tsx: reads planType itself']);
  assert.deepEqual(violations('x.tsx', "const s = st.state === 'detecting' ? 'Checking…' : '';"), ['x.tsx: says "Checking…" itself']);
  assert.deepEqual(violations('x.tsx', 'return <span>Managed by {b.label}</span>;'), ['x.tsx: says "Managed by" itself']);
  assert.deepEqual(violations('x.tsx', 'const l = `Limit reached · ${x}`;'), ['x.tsx: says "Limit reached" itself']);
  assert.deepEqual(violations('x.tsx', '<Row title="Not signed in" />'), ['x.tsx: says "Not signed in" itself']);
  // prose that only begins with a status word is not a status line
  assert.deepEqual(violations('x.tsx', '<Tooltip label="Billed per token to your API key." />'), []);
  // a comment may name what it is about
  assert.deepEqual(violations('x.tsx', "// 'Checking…' comes from the view, not accountStatusText(a)\n/* .limits */"), []);
});
