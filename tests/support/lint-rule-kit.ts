// Checks a renderer lint rule's registration: biome.json runs it over src, and lint/baseline.json records it at zero.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** `grit` is the rule as biome.json lists it (`./lint/rules/<name>.grit`); its baseline entry must be empty. */
export function assertRendererRuleAtZero(grit: string) {
  const biome = JSON.parse(read('biome.json'));
  const override = biome.overrides.find((o: { plugins?: string[] }) => o.plugins?.includes(grit));
  assert.ok(override, `register ${grit.slice(2)} in biome.json`);
  assert.ok(override.includes.includes('src/**'), `${grit} covers the renderer`);
  assert.deepEqual(JSON.parse(read('lint/baseline.json')).rules[`plugin/${path.basename(grit, '.grit')}`], {});
}
