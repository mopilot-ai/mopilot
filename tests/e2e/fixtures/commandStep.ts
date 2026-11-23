// Match a command step's exact accessible label: a completed one with only the duration grammar owned by src/lib/format.ts,
// a running one as its transcript row names the program.
const seconds = '(?:[0-9]|[1-5][0-9])';
const positive = '(?:[1-9]|[1-5][0-9])';
const duration = `(?:${seconds}s|${positive}m(?: ${positive}s)?|[1-9][0-9]*h ${seconds}m)`;
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Keep the full command and exit outcome exact; elapsed time is reported by the harness and varies between runs. */
export function commandStepName(label: string) {
  // Unlike $, this end assertion does not accept an extra final newline.
  return new RegExp(`^${literal(label)}(?: · ${duration})?(?![\\s\\S])`);
}

/** A command still running: "Running <program>", with the ellipsis when the program was cut (src/session/activityUx.ts). */
export function runningCommandName(program: string) {
  return new RegExp(`^Running ${literal(program)}…?(?![\\s\\S])`);
}
