// node:test reporter that says why a whole test file failed outside its tests (a crash, or an exit after they passed).
//
// node:test reports such a file only as "test failed": a process killed by a signal (a crash in Node itself) and
// an unhandled rejection after a test ended (async work that outlived it) look the same in the summary, and the
// diagnostic that names the rejection is printed far above it. This reporter lists each such file once the run
// ends, with its exit and the diagnostics about work that outlived a test (docs/unit-coverage.md#whole-file-failures).

const OUTLIVED = /after the test ended|unhandledRejection|uncaughtException/;

/**
 * Why a failed test is a whole-file failure outside its tests, or null when it is not one.
 * @param {{ details?: { error?: any } }} data a `test:fail` event's data
 */
export function fileFailure(data) {
  const error = data.details?.error;
  if (error?.code !== 'ERR_TEST_FAILURE' || error.failureType !== 'testCodeFailure') return null;
  if (error.signal === 'SIGSEGV' || error.signal === 'SIGBUS')
    return `its process was killed by ${error.signal} before it finished: a crash in Node or V8, not a failed assertion (rerun it; docs/unit-coverage.md#whole-file-failures)`;
  if (error.signal)
    return `its process was killed by ${error.signal} before it finished: by the test watchdog (its [rss-watchdog] or [file-timeout] line above says why), out of memory (SIGABRT from V8, SIGKILL from the system) or stopped from outside, not a failed assertion`;
  if (typeof error.exitCode === 'number' && error.exitCode !== 0)
    return `its process exited with code ${error.exitCode} outside any test: an unhandled rejection or exception, or work that outlived a test`;
  return null;
}

/** @param {AsyncIterable<{ type: string, data: any }>} source */
export default async function* fileFailures(source) {
  /** @type {Map<string, string[]>} */
  const outlived = new Map();
  /** @type {{ file: string, why: string }[]} */
  const failed = [];
  for await (const { type, data } of source) {
    if (type === 'test:diagnostic' && data.file && OUTLIVED.test(data.message)) {
      outlived.set(data.file, [...(outlived.get(data.file) ?? []), data.message]);
    } else if (type === 'test:fail') {
      const why = fileFailure(data);
      if (why) failed.push({ file: data.file ?? data.name, why });
    }
  }
  if (!failed.length) return;
  let out = '\nWhole-file failures (no failing test):\n';
  for (const { file, why } of failed) {
    out += `✖ ${file}: ${why}\n`;
    for (const message of outlived.get(file) ?? []) out += `  ${message}\n`;
  }
  yield out;
}
