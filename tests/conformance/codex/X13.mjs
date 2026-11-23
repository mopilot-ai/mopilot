// Schema facts that contradict or confirm the design, from the generated JSON schema. No app-server, no model.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const id = 'X13';
export const title = 'Other schema contradictions with the design';
export const timeoutMs = 120000;

const methodsOf = (text) =>
  new Set(
    [...text.matchAll(/"method"\s*:\s*\{\s*"enum"\s*:\s*\[\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .concat([...text.matchAll(/"const"\s*:\s*"([a-zA-Z]+\/[^"]+)"/g)].map((m) => m[1])),
  );

function generate(ctx, experimental) {
  const out = ctx.cwd(experimental ? 'schema-exp' : 'schema-stable');
  execFileSync(ctx.bin, ['app-server', 'generate-json-schema', '--out', out, ...(experimental ? ['--experimental'] : [])], {
    timeout: 60000,
    stdio: 'ignore',
  });
  return out;
}
const readAll = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.json'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');

export default async function run(ctx) {
  const expDir = generate(ctx, true);
  const exp = readAll(expDir);
  const stable = readAll(generate(ctx, false));
  const em = methodsOf(exp);
  const sm = methodsOf(stable);
  const goalSet = fs.readFileSync(path.join(expDir, 'v2/ThreadGoalSetParams.json'), 'utf8');
  const experimentalOnly = ['thread/search', 'thread/settings/update', 'collaborationMode/list', 'thread/backgroundTerminals/list'];
  const o = {
    methodCount: { experimental: em.size, stable: sm.size },
    goalSetFields: Object.keys(JSON.parse(goalSet).properties ?? {}).sort(),
    experimentalOnly: Object.fromEntries(experimentalOnly.map((m) => [m, em.has(m) && !sm.has(m)])),
    hasRevert: em.has('thread/revert'),
    hasRollback: em.has('thread/rollback'),
    hasListVoices: em.has('thread/realtime/listVoices'),
    namespaceToolsFlag: /namespaceTools/.test(exp),
    detachedDeprecated: /Detached delivery is deprecated/.test(exp),
    multiAgentModeDeprecated: /@deprecated[^"]*Ultra reasoning effort for proactive multi-agent/i.test(exp),
    compactedDeprecated: /Deprecated: Use `ContextCompaction` item type instead/.test(exp),
  };
  return ctx.result(o, {
    'methods were found in the schema': em.size > 50,
    'thread/goal/set has no appendTranscriptItem': !o.goalSetFields.includes('appendTranscriptItem'),
    'no namespaceTools capability flag': !o.namespaceToolsFlag,
    'search/settings/collaborationMode/backgroundTerminals are experimental-only': Object.values(o.experimentalOnly).every(Boolean),
    'thread/revert exists, thread/rollback does not': o.hasRevert && !o.hasRollback,
    'thread/realtime/listVoices exists': o.hasListVoices,
    'detached review delivery is deprecated': o.detachedDeprecated,
    'multiAgentMode is deprecated in favour of effort ultra': o.multiAgentModeDeprecated,
    'thread/compacted is deprecated': o.compactedDeprecated,
  });
}
