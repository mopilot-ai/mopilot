// The CUJ matrix (docs/multi-harness/journeys.json) stays in step with tests/e2e and JOURNEY-COVERAGE.md: every spec it names exists, every journey has a row in the doc, and the doc's numbers are the file's counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

type Status = 'Covered' | 'Partial' | 'None' | 'N/A';
type Journey = {
  id: string;
  priority: string;
  source: string;
  tier?: string;
  specs: string[];
  status: { codex: Status; claude: Status; acp?: Status };
  gap?: string;
};

const matrix = JSON.parse(fs.readFileSync('docs/multi-harness/journeys.json', 'utf8')) as {
  tiers: Record<string, string>;
  journeys: Journey[];
};
const doc = fs.readFileSync('docs/multi-harness/JOURNEY-COVERAGE.md', 'utf8');
const STATUSES = new Set(['Covered', 'Partial', 'None', 'N/A']);

const count = (journeys: Journey[], keys: ('codex' | 'claude' | 'acp')[]) => {
  const n = { Covered: 0, Partial: 0, None: 0 };
  for (const j of journeys) for (const k of keys) if (j.status[k] && j.status[k] !== 'N/A') n[j.status[k] as keyof typeof n]++;
  return [n.Covered, n.Partial, n.None];
};
// the Covered | Partial | None cells of the Numbers row whose label starts with `label`
const numbersRow = (label: string) => {
  const row = doc.split('\n').find((line) => line.startsWith(`| ${label}`));
  assert.ok(row, `no Numbers row "${label}"`);
  return row
    .split('|')
    .slice(2, 5)
    .map((cell) => Number(cell.trim()));
};

test('journey ids are unique and every entry is well formed', () => {
  const ids = matrix.journeys.map((j) => j.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const j of matrix.journeys) {
    assert.match(j.priority, /^P[012]$/, j.id);
    assert.ok(['matrix', 'newJourneys', 'gap'].includes(j.source), j.id);
    for (const s of Object.values(j.status)) assert.ok(STATUSES.has(s), `${j.id}: ${s}`);
    if (j.tier !== undefined) {
      assert.ok(j.tier in matrix.tiers, `${j.id}: tier ${j.tier}`);
      assert.ok(j.gap, `${j.id} is in the gap list without saying what is missing`);
    }
    if (j.source === 'gap') assert.ok(j.tier && j.status.acp, `${j.id}: a gap journey has a tier and an ACP status`);
  }
});

test('every spec a journey names exists in tests/e2e', () => {
  for (const j of matrix.journeys) for (const spec of j.specs) assert.ok(fs.existsSync(`tests/e2e/${spec}.spec.ts`), `${j.id}: ${spec}`);
});

test('every journey has its row in JOURNEY-COVERAGE.md, and every gap journey is in its tier table', () => {
  for (const j of matrix.journeys) assert.ok(doc.includes(`### ${j.id}\n`) || doc.includes(`| ${j.id} |`), j.id);
  for (const tier of Object.keys(matrix.tiers)) {
    const table = doc.split(`### Tier ${tier}:`)[1]?.split('\n### ')[0] ?? '';
    for (const j of matrix.journeys.filter((x) => x.tier === tier)) assert.ok(table.includes(`| ${j.id} |`), `${j.id} not in tier ${tier}`);
  }
});

test("the doc's numbers are the matrix's counts", () => {
  const designed = matrix.journeys.filter((j) => j.source !== 'gap');
  const gap = matrix.journeys.filter((j) => j.source === 'gap');
  assert.equal(designed.length, 27);
  assert.deepEqual(numbersRow('After'), count(designed, ['codex', 'claude']));
  assert.deepEqual(numbersRow('Gap list, first-class'), count(gap, ['codex', 'claude']));
  assert.deepEqual(numbersRow('Gap list, ACP'), count(gap, ['acp']));
  assert.match(doc, new RegExp(`Gap list, first-class harnesses \\(${gap.length} journeys, ${gap.length * 2} cells\\)`));
});
