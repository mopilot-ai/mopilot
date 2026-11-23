// Guard (#4649 A4): MoMo's own write tools (Calendar and Reminders, sources/writeTools.cjs) reach no one but the user. If one ever gains an argument that names people (attendees, a shared list's members, a send) or a send's name, this fails, so its card must carry those recipients (momo/recipients.cjs) before it ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registerWriteTools } = require('../electron/momo/sources/writeTools.cjs');
const { FIELDS, VERBS } = require('../electron/momo/recipients.cjs');

test('no MoMo write tool names recipients in its arguments or is a send by name', () => {
  const tools: any[] = [];
  registerWriteTools({ register: (t: any) => (tools.push(t), () => {}) } as any, {
    writer: {} as any,
    allowed: () => true,
    isMomoChat: () => true,
  });
  assert.ok(tools.length >= 4);
  for (const t of tools) {
    const words = t.name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/);
    assert.deepEqual(
      words.filter((w: string) => VERBS.has(w)),
      [],
      `${t.name} reads as a send`,
    );
    const named = Object.keys(t.schema.properties ?? {}).filter((k) => FIELDS.has(k.toLowerCase().replace(/[^a-z0-9]/g, '')));
    assert.deepEqual(named, [], `${t.name} names recipients`);
  }
});
