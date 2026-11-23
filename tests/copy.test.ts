// Validate canonical harness copy against the design, reason tables and production formatters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { COPY, WHY, WHY_FALLBACK, fmt, copy, admissionFailure } = await import('../src/harness/copy.ts');
const caps = await import('../src/harness/caps.ts');
const { SEMANTICS, WHY_LAYERS } = await import('../src/harness/adapter.ts');
const { FAST_BLOCKED_TEXT } = await import('../src/harness/types.ts');

/** Every Why code caps.ts can emit, by running each gate with everything blocked. */
function emittedCodes(): Set<string> {
  const gates = [
    caps.versionGate({ probes: {} } as never, { multiAgent: ['claude.getSettings'] }),
    caps.providerGate({ id: 'x', drops: [...SEMANTICS] } as never),
    caps.providerGate({ id: 'mopilot', drops: ['speed'] } as never),
    caps.modelGate({ serviceTiers: [], ultra: false, efforts: [] } as never),
    caps.accountGate({ fast: false, fastBlocked: null } as never),
    caps.accountGate({ fast: true, artifacts: false } as never),
    caps.flagGate({ 'user.artifacts': false }),
    caps.accountGate({ fast: false, fastBlocked: 'something_new' } as never),
    ...Object.keys(FAST_BLOCKED_TEXT).map((k) => caps.accountGate({ fast: false, fastBlocked: k } as never)),
    caps.flagGate(
      Object.fromEntries([...SEMANTICS.map((s) => [`sage.${s}`, false]), ['features.goals', false], ['features.memories', false]]),
    ),
    caps.sessionGate({ runningElsewhere: true, turn: 'idle' } as never, true),
    caps.sessionGate({ runningElsewhere: false, turn: 'running' } as never),
    caps.sessionGate({ runningElsewhere: false, turn: 'idle', artifacts: false } as never),
    caps.sessionGate({ runningElsewhere: false, turn: 'idle', artifacts: false, artifactsStale: true } as never),
  ];
  const codes = new Set<string>(['harness.undeclared', 'harness.noArtifacts']);
  for (const g of gates) for (const why of Object.values(g)) codes.add(why!.code);
  return codes;
}

test('every Why code caps.ts emits has a line in the copy table', () => {
  const codes = emittedCodes();
  assert.ok(codes.size > 12);
  for (const c of codes) assert.ok(WHY[c], `no copy for ${c}`);
});

test('Why keys are <layer>.<code> and every layer has a fallback', () => {
  for (const k of Object.keys(WHY)) assert.match(k, new RegExp(`^(${WHY_LAYERS.join('|')})\\.`));
  for (const l of WHY_LAYERS) assert.ok(WHY_FALLBACK[l], l);
});

test('every semantic has a feature label for the Why text', () => {
  for (const s of SEMANTICS) assert.ok(caps.FEATURE_LABEL[s], s);
});

test('the copy table carries every string in the design, in English', () => {
  const design = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'docs', 'multi-harness', 'design-v2.json'), 'utf8')).copy as {
    surface: string;
    en: string;
  }[];
  const have = new Set<string>();
  const walk = (o: unknown) => (typeof o === 'string' ? have.add(o) : o && typeof o === 'object' && Object.values(o).forEach(walk));
  walk(COPY);
  walk(WHY);
  // the Why lines are generalized over {label}, {provider} and {feature}; they are checked by key above
  const generalized =
    /^(Fast isn't available on MoPilot|The DeepSeek endpoint|Goals are off in Codex|Claude Code \{version\}|This model can't auto-approve|Claude Code only takes feedback)/;
  const missing = design.filter((c) => !have.has(c.en) && !generalized.test(c.en)).map((c) => c.surface);
  assert.deepEqual(missing, []);
});

test('copy values are English only', () => {
  const bad: string[] = [];
  const walk = (o: unknown, at: string) => {
    if (typeof o === 'string') return void (/[一-鿿]/.test(o) && bad.push(at));
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${at}.${k}`);
  };
  walk(COPY, 'COPY');
  walk(WHY, 'WHY');
  assert.deepEqual(bad, []);
});

test('admission failure copy agrees with the production formatter and preserves the actual reason', () => {
  const reason = "MoPilot can't give Antigravity computer and browser control";
  assert.equal(copy('harness', 'admissionFailed', { reason }), admissionFailure(reason));
  assert.equal(admissionFailure(null), "Installed · Can't run in MoPilot");
  assert.equal(admissionFailure(''), admissionFailure(null));
  assert.equal(admissionFailure(reason), `Installed · Can't run in MoPilot · ${reason}`);
});

test('fmt fills placeholders and drops missing ones', () => {
  assert.equal(copy('goalBar', 'claudeRunning', { condition: 'tests pass', n: 3 }), 'Goal: tests pass · round 3  [Pause] [Clear]');
  assert.equal(fmt('{label} quit  {x}', { label: 'Codex' }), 'Codex quit ');
  assert.equal(copy('notifications', 'coalesced', { n: 2 }), '2 chats need you');
  assert.equal(copy('commands', 'unknownCodex'), "Codex doesn't have this command · Send as plain text");
});
