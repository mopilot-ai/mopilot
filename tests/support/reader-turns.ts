// Waits for a JSON reader (electron/transport/jsonReader.cjs) to deliver what one read queued: past its time budget a read's
// lines go on in later turns of the loop, so a test that pushes several lines and asserts at once fails when the machine is busy.
import { setImmediate as turn } from 'node:timers/promises';

/** Let the readers' later slices run: each turn delivers at least one line, so `turns` covers that many lines. */
export async function readerTurns(turns = 32) {
  for (let i = 0; i < turns; i++) await turn();
}
