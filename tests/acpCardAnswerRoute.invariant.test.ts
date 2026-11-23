// Every answer to a card on the ACP event bus goes through electron/harness/acp/cardAnswer.cjs: a surface that called the local ACP host's permission() itself would drop the answer to a Host chat's card (the side panel and phones did, while the window's IPC routed it to the Host).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const ROUTE = 'electron/harness/acp/cardAnswer.cjs';
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(c|m)?js$/.test(e.name) ? [path.join(dir, e.name)] : []));

test('I: only the shared route calls the ACP host’s permission() to answer a card', () => {
  const offenders = files(path.join(ROOT, 'electron'))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .filter((f) => f !== ROUTE)
    .filter((f) => /\b(?:acpHost|host)\??\.permission\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(
    offenders,
    [],
    'answer a card with answerAcpCard (electron/harness/acp/cardAnswer.cjs) so a Host chat’s card reaches its Host',
  );
  // the route itself is still there to find
  assert.match(fs.readFileSync(path.join(ROOT, ROUTE), 'utf8'), /acpHost\.permission\(/);
});
