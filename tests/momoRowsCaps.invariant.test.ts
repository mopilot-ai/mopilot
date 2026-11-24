// A whole-repository guard: the open cards and questions that can wait together always fit in the rows store's open-row limit, so the store never ends (void) an approval row the gate would still honour.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import { MAX_WAITING } from '../host/src/momoGateBound.mjs';
// @ts-ignore
import { PENDING_KEEP } from '../host/src/momoRows.mjs';
// @ts-ignore
import { MAX_PENDING } from '../host/src/momoServices/questions.mjs';

test('the cards and questions that can wait fit in the open rows the store keeps', () => {
  assert.ok(
    MAX_WAITING + MAX_PENDING <= PENDING_KEEP,
    `${MAX_WAITING} cards + ${MAX_PENDING} questions must fit in ${PENDING_KEEP} open rows`,
  );
});
