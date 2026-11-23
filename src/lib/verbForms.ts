// A step description in the running form Claude Code's activity line uses: "Run the tests" reads "Running the tests".

/** Irregular past forms; their keys are also verbs the line knows. */
const PAST: Record<string, string> = {
  begin: 'began',
  bind: 'bound',
  bring: 'brought',
  build: 'built',
  buy: 'bought',
  catch: 'caught',
  choose: 'chose',
  come: 'came',
  cut: 'cut',
  debug: 'debugged',
  dig: 'dug',
  do: 'did',
  draw: 'drew',
  feed: 'fed',
  feel: 'felt',
  fight: 'fought',
  find: 'found',
  fly: 'flew',
  forget: 'forgot',
  freeze: 'froze',
  get: 'got',
  give: 'gave',
  go: 'went',
  have: 'had',
  hide: 'hid',
  hit: 'hit',
  hold: 'held',
  input: 'input',
  keep: 'kept',
  know: 'knew',
  lead: 'led',
  leave: 'left',
  let: 'let',
  lose: 'lost',
  make: 'made',
  mean: 'meant',
  meet: 'met',
  override: 'overrode',
  overwrite: 'overwrote',
  pay: 'paid',
  put: 'put',
  quit: 'quit',
  read: 'read',
  rebuild: 'rebuilt',
  redo: 'redid',
  rerun: 'reran',
  reset: 'reset',
  rewrite: 'rewrote',
  run: 'ran',
  see: 'saw',
  seek: 'sought',
  send: 'sent',
  set: 'set',
  show: 'showed',
  shut: 'shut',
  sit: 'sat',
  sleep: 'slept',
  spend: 'spent',
  spin: 'spun',
  split: 'split',
  spread: 'spread',
  stand: 'stood',
  sweep: 'swept',
  sync: 'synced',
  take: 'took',
  teach: 'taught',
  tear: 'tore',
  tell: 'told',
  think: 'thought',
  throw: 'threw',
  understand: 'understood',
  undo: 'undid',
  unset: 'unset',
  win: 'won',
  unwrap: 'unwrapped',
  unzip: 'unzipped',
  write: 'wrote',
};

/** Running forms that double a consonant or are otherwise irregular. */
const RUNNING: Record<string, string> = {
  begin: 'beginning',
  commit: 'committing',
  control: 'controlling',
  debug: 'debugging',
  emit: 'emitting',
  equip: 'equipping',
  forget: 'forgetting',
  format: 'formatting',
  input: 'inputting',
  occur: 'occurring',
  omit: 'omitting',
  output: 'outputting',
  permit: 'permitting',
  prefer: 'preferring',
  quit: 'quitting',
  refer: 'referring',
  rerun: 'rerunning',
  reset: 'resetting',
  screenshot: 'screenshotting',
  snapshot: 'snapshotting',
  submit: 'submitting',
  sync: 'syncing',
  transfer: 'transferring',
  unset: 'unsetting',
  unwrap: 'unwrapping',
  unzip: 'unzipping',
};

/** Words that are already past forms, never imperatives. */
const NOT_IMPERATIVE = new Set([
  ...Object.entries(PAST)
    .filter(([verb, past]) => verb !== past)
    .map(([, past]) => past),
  ...'been broken chosen done drawn driven eaten fallen forgotten given gone grown hidden known ridden risen seen shown spoken taken thrown torn worn written'.split(
    ' ',
  ),
]);

const COMMON = (
  'add analyze append apply archive assert attempt audit autofix await benchmark bisect call capture check click clone ' +
  'collect compare compile compute confirm connect convert copy count create curl decode delete deploy detect disable ' +
  'discard dismiss display download dump edit emit enable encode ensure enumerate evaluate execute expand expect export ' +
  'extract fetch fill filter fix flush focus follow generate grep identify ignore import include inject insert inspect ' +
  'install invoke kill launch lint list load locate loop measure merge monitor move navigate normalize parse patch pick ' +
  'ping pipe poll post prepare preview print probe profile prune publish pull push queue rebase recheck record recover ' +
  'redirect reduce refresh regenerate reinstall relaunch reload remove rename render reopen repeat replay reply report ' +
  'request resolve restart restore retry revert save scan screenshot scroll search select serialize serve settle skip ' +
  'snapshot sort spawn squash stage start stash stop strip summarize switch sync tail tally test toggle touch trace ' +
  'track trigger trim truncate try typecheck unblock uninstall unlink unmount unpack update upgrade upload validate ' +
  'verify visit wait walk warn wipe'
).split(' ');

/** Every verb the line conjugates. */
const VERBS = new Set([...Object.keys(PAST), ...Object.keys(RUNNING), ...COMMON]);
/** Verbs that are also common nouns or adjectives: not conjugated after "and" or "then". */
const NOUNISH = new Set(
  'output input lead feed spread set cut split hit let put quit shut read go make dig tear win fly spin control permit have hold keep mean feel do see know think understand'.split(
    ' ',
  ),
);
const CHAINED = new Set([...VERBS].filter((v) => !NOUNISH.has(v)));
const AND_THEN = /(?<![\w-])((?:(?:[Aa]nd|[Tt]hen)\s+)+)([a-z]{2,16})(?=$|[\s,;!?]|\.(?:\s|$))/g;
const FOLLOWED_BY_VERB =
  /^(?:\s+\w+){0,2}\s+(?:is|are|was|were|has|have|do|does|did|will|would|should|can|could|passes|passed|fails|failed|exists|works|worked|succeeds|succeeded|stays|remains|looks|runs|ran|not|if|when|unless|whether)(?:n['’]t)?\b/;
const PREFIXED = /^(re|un|de|pre|co|sub|over|out|mis|auto|post)-(.+)$/i;
const CVC = /[^aeiou][aeiou][bcdfghjklmnpqrstvz]$/i;

const vowels = (w: string) => w.replace(/[^aeiou]/gi, '').length;

/** A verb's -ing form. */
export function runningForm(verb: string): string {
  const lower = verb.toLowerCase();
  if (Object.hasOwn(RUNNING, lower)) return RUNNING[lower];
  if (/ie$/i.test(verb)) return `${verb.slice(0, -2)}ying`;
  if (/[^eoy]e$/i.test(verb)) return `${verb.slice(0, -1)}ing`;
  if (CVC.test(verb) && vowels(verb) === 1) return `${verb}${verb.slice(-1)}ing`;
  if (/c$/i.test(verb)) return `${verb}king`;
  return `${verb}ing`;
}

/** The form keeps the original word's leading capital. */
function matchCase(original: string, form: string): string {
  return /^[A-Z]/.test(original) ? form.charAt(0).toUpperCase() + form.slice(1) : form;
}

/** Whether a word can be an imperative verb (not a gerund, a past form or a plural). */
function verbLike(word: string): boolean {
  if (word.length < 2 || word.length > 16 || !/^[A-Za-z]+$/.test(word) || word === word.toUpperCase()) return false;
  const lower = word.toLowerCase();
  if (NOT_IMPERATIVE.has(lower)) return false;
  if (Object.hasOwn(PAST, lower)) return true;
  if ((/ing$/i.test(word) && word.length > 4) || (/ed$/i.test(word) && !/eed$/i.test(word) && word.length > 3)) return false;
  if (/s$/i.test(word) && !/(ss|us)$/i.test(word) && word.length > 3) return false;
  return /[aeiou]/i.test(word) || /y/i.test(word);
}

/** "and then check" later in the description moves to the running form too. */
function chained(rest: string): string {
  return rest.replace(AND_THEN, (whole, joiner: string, verb: string, at: number) =>
    CHAINED.has(verb) && !FOLLOWED_BY_VERB.test(rest.slice(at + whole.length)) ? joiner + runningForm(verb) : whole,
  );
}

/** A description that starts with a verb, in its running form; undefined when it does not start with one the line knows. */
export function runningDescription(description: string): string | undefined {
  const body = description.trimStart();
  const lead = description.slice(0, description.length - body.length);
  const m = /^(\S+)([\s\S]*)$/.exec(body);
  if (!m) return undefined;
  const [, word, rest] = m;
  const prefixed = PREFIXED.exec(word);
  if (prefixed && verbLike(prefixed[2])) {
    const [, prefix, stem] = prefixed;
    const whole = (prefix + stem).toLowerCase();
    const lowerStem = stem.toLowerCase();
    if (NOT_IMPERATIVE.has(whole) || NOT_IMPERATIVE.has(lowerStem) || (!VERBS.has(whole) && !VERBS.has(lowerStem))) return undefined;
    const ing = Object.hasOwn(RUNNING, whole) ? RUNNING[whole].slice(prefix.length) : runningForm(stem);
    return `${lead}${prefix}-${matchCase(stem, ing)}${chained(rest)}`;
  }
  if (!verbLike(word) || !VERBS.has(word.toLowerCase())) return undefined;
  return `${lead}${matchCase(word, runningForm(word))}${chained(rest)}`;
}
