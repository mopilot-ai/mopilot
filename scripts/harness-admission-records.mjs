// Combines historic ACP admission evidence with individual harness records, refusing identity collisions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests/conformance/results');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** New probes live in admission/<id>.json instead of appending to the shared historical snapshot. */
export function loadAdmission(file = path.join(RESULTS, 'acp-admission.json'), dir = path.join(RESULTS, 'admission')) {
  const aggregate = read(file);
  if (!fs.existsSync(dir)) return aggregate;
  const platforms = new Set([aggregate.platform]);
  const notes = [aggregate.how];
  for (const name of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const record = read(path.join(dir, name));
    const id = path.basename(name, '.json');
    if (record.id !== id) throw new Error(`${name}: admission id must match its file name`);
    if (Object.hasOwn(aggregate.harnesses, id)) throw new Error(`${name}: duplicate admission id ${id}`);
    aggregate.harnesses = { ...aggregate.harnesses, [id]: record };
    platforms.add(record.platform);
    notes.push(record.how);
  }
  return { ...aggregate, platform: [...platforms].join('; '), how: notes.join(' ') };
}
