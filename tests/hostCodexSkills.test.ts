// The skills Codex lists for a folder on a machine (host/src/codexSkills.mjs, #4915): read through the family the Host built, after its own check, from the folder asked, else the Host's home; refused before the family exists or when Codex cannot run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { codexSkills } from '../host/src/codexSkills.mjs';

const asked: object[] = [];
const family = (running: any) => ({ running: () => running });
const built = (check: () => Promise<void> = async () => undefined) => ({
  check,
  codex: { request: async (method: string, params: object) => (asked.push({ method, params }), { data: [] }) },
});

test('the skills of a folder are asked of Codex for that folder, else the Host’s home, else for none', async () => {
  const read = codexSkills(family(built()), '/home/host');
  assert.deepEqual(await read('/srv/app'), { data: [] });
  await read();
  await codexSkills(family(built()), undefined)();
  assert.deepEqual(asked, [
    { method: 'skills/list', params: { cwds: ['/srv/app'] } },
    { method: 'skills/list', params: { cwds: ['/home/host'] } },
    { method: 'skills/list', params: { cwds: [] } },
  ]);
});

test('before the family is built, or when Codex is missing or not signed in, the read refuses', async () => {
  await assert.rejects(codexSkills(family(null), '/h')('/p'), /has not started/);
  const refusing = built(async () => Promise.reject(Object.assign(new Error('not signed in'), { code: 'harness_not_configured' })));
  await assert.rejects(codexSkills(family(refusing), '/h')('/p'), (e: any) => e.code === 'harness_not_configured');
});
