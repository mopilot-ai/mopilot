// Every unit test checks the JSON main keeps of a stream event (electron/harness/eventJson.cjs) against the event as it is
// when a window's batch reads it: the text is taken when the delta crosses to the core, so an adapter that changed the
// event after emitting it would send the old text, silently, where a clone at send time took the change.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * `knownJson` that also says (`report`) when the kept text is no longer the event's.
 * @param {(event: unknown) => string | undefined} knownJson @param {(error: Error) => void} report
 */
export function checkedKnownJson(knownJson: (event: unknown) => string | undefined, report: (error: Error) => void) {
  return (event: unknown) => {
    const json = knownJson(event);
    if (json !== undefined && json !== JSON.stringify(event))
      report(new Error(`a stream event changed after main kept its JSON: kept ${json.slice(0, 200)}`));
    return json;
  };
}

/**
 * Put the check in place before any module takes `knownJson`: a failure is thrown outside the send that caught it (a
 * window's send notes its errors), so the test file fails.
 */
export function checkKeptJson() {
  const kept = require('../../electron/harness/eventJson.cjs');
  kept.knownJson = checkedKnownJson(kept.knownJson, (error) =>
    queueMicrotask(() => {
      throw error;
    }),
  );
}
