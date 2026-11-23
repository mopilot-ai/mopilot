// Conjugates the lead verb of a task description ("Track A: …" → "Tracking A: …" / "Tracked A: …"), as Claude Desktop labels agents.

/** Irregular past tenses. */
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

/** Present participles the general rule would miss. (No listed verb ends in -ie or -c, so those rules are left out.) */
const GERUND: Record<string, string> = {
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

/** Words that are already past forms: a description starting with one is left alone. */
const ALREADY_PAST = new Set([
  ...Object.entries(PAST)
    .filter(([base, past]) => base !== past)
    .map(([, past]) => past),
  'been',
  'broken',
  'chosen',
  'done',
  'drawn',
  'driven',
  'eaten',
  'fallen',
  'forgotten',
  'given',
  'gone',
  'grown',
  'hidden',
  'known',
  'ridden',
  'risen',
  'seen',
  'shown',
  'spoken',
  'taken',
  'thrown',
  'torn',
  'worn',
  'written',
]);

const REGULAR =
  'add.analyze.append.apply.archive.assert.attempt.audit.autofix.await.benchmark.bisect.call.capture.check.click.clone.collect.compare.compile.compute.confirm.connect.convert.copy.count.create.curl.decode.delete.deploy.detect.disable.discard.dismiss.display.download.dump.edit.emit.enable.encode.ensure.enumerate.evaluate.execute.expand.expect.export.extract.fetch.fill.filter.fix.flush.focus.follow.generate.grep.identify.ignore.import.include.inject.insert.inspect.install.invoke.kill.launch.lint.list.load.locate.loop.measure.merge.monitor.move.navigate.normalize.parse.patch.pick.ping.pipe.poll.post.prepare.preview.print.probe.profile.prune.publish.pull.push.queue.rebase.recheck.record.recover.redirect.reduce.refresh.regenerate.reinstall.relaunch.reload.remove.rename.render.reopen.repeat.replay.reply.report.request.resolve.restart.restore.retry.revert.save.scan.screenshot.scroll.search.select.serialize.serve.settle.skip.snapshot.sort.spawn.squash.stage.start.stash.stop.strip.summarize.switch.sync.tail.tally.test.toggle.touch.trace.track.trigger.trim.truncate.try.typecheck.unblock.uninstall.unlink.unmount.unpack.update.upgrade.upload.validate.verify.visit.wait.walk.warn.wipe'.split(
    '.',
  );

/** Every verb a description may lead with. */
const VERBS = new Set([...Object.keys(PAST), ...Object.keys(GERUND), ...REGULAR]);
/** Verbs that read as nouns after "and"/"then" too often to conjugate there. */
const NOUNISH = new Set(
  'output.input.lead.feed.spread.set.cut.split.hit.let.put.quit.shut.read.go.make.dig.tear.win.fly.spin.control.permit.have.hold.keep.mean.feel.do.see.know.think.understand'.split(
    '.',
  ),
);
const CHAINABLE = new Set([...VERBS].filter((v) => !NOUNISH.has(v)));
const CHAIN_RE = /(?<![\w-])((?:(?:[Aa]nd|[Tt]hen)\s+)+)([a-z]{2,16})(?=$|[\s,;!?]|\.(?:\s|$))/g;
/** What follows a chained word when it is the subject of a clause, not a verb ("then tests pass"). */
const CLAUSE_RE =
  /^(?:\s+\w+){0,2}\s+(?:is|are|was|were|has|have|do|does|did|will|would|should|can|could|passes|passed|fails|failed|exists|works|worked|succeeds|succeeded|stays|remains|looks|runs|ran|not|if|when|unless|whether)(?:n['’]t)?\b/;
const PREFIX_RE = /^(re|un|de|pre|co|sub|over|out|mis|auto|post)-(.+)$/i;
const CVC_RE = /[^aeiou][aeiou][bcdfghjklmnpqrstvz]$/i;

const vowels = (w: string) => w.replace(/[^aeiou]/gi, '').length;

function gerund(w: string): string {
  const l = w.toLowerCase();
  if (Object.hasOwn(GERUND, l)) return GERUND[l];
  if (/[^eoy]e$/i.test(w)) return w.slice(0, -1) + 'ing';
  if (CVC_RE.test(w) && vowels(w) === 1) return w + w.slice(-1) + 'ing';
  return w + 'ing';
}

function past(w: string): string {
  const l = w.toLowerCase();
  if (Object.hasOwn(PAST, l)) return PAST[l];
  if (/e$/i.test(w)) return w + 'd';
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + 'ied';
  if (CVC_RE.test(w) && vowels(w) === 1) return w + w.slice(-1) + 'ed';
  if (Object.hasOwn(GERUND, l)) return GERUND[l].slice(0, -3) + 'ed';
  return w + 'ed';
}

/** Keep the original word's leading capital. */
const matchCase = (orig: string, w: string) => (/^[A-Z]/.test(orig) ? w.charAt(0).toUpperCase() + w.slice(1) : w);

/** Whether a word can be a bare verb at all (not an acronym, not already inflected). */
function bareVerb(w: string): boolean {
  if (w.length < 2 || w.length > 16 || !/^[A-Za-z]+$/.test(w) || w === w.toUpperCase()) return false;
  const l = w.toLowerCase();
  if (ALREADY_PAST.has(l)) return false;
  if (Object.hasOwn(PAST, l)) return true;
  if (
    (/ing$/i.test(w) && w.length > 4) ||
    (/ed$/i.test(w) && !/eed$/i.test(w) && w.length > 3) ||
    (/s$/i.test(w) && !/(ss|us)$/i.test(w) && w.length > 3)
  )
    return false;
  return /[aeiou]/i.test(w) || /y/i.test(w);
}

/** Conjugate verbs chained with "and"/"then" in the rest of the description. */
const chain = (rest: string, f: (w: string) => string) =>
  rest.replace(CHAIN_RE, (m, lead: string, w: string, at: number) =>
    CHAINABLE.has(w) && !CLAUSE_RE.test(rest.slice(at + m.length)) ? lead + f(w) : m,
  );

export interface Conjugated {
  running: string;
  done: string;
}

/** The running and done forms of a description that leads with a known verb; undefined otherwise. */
export function conjugateLead(description: string): Conjugated | undefined {
  const trimmed = description.trimStart();
  const pad = description.slice(0, description.length - trimmed.length);
  const m = /^(\S+)([\s\S]*)$/.exec(trimmed);
  if (!m) return undefined;
  const [, word, rest] = m;
  const pre = PREFIX_RE.exec(word);
  if (pre && bareVerb(pre[2])) {
    const [, prefix, stem] = pre;
    const joined = (prefix + stem).toLowerCase();
    const bare = stem.toLowerCase();
    if (ALREADY_PAST.has(joined) || ALREADY_PAST.has(bare) || (!VERBS.has(joined) && !VERBS.has(bare))) return undefined;
    const form = (table: Record<string, string>, f: (w: string) => string) =>
      prefix + '-' + matchCase(stem, Object.hasOwn(table, joined) ? table[joined].slice(prefix.length) : f(stem));
    return { running: pad + form(GERUND, gerund) + chain(rest, gerund), done: pad + form(PAST, past) + chain(rest, past) };
  }
  if (!bareVerb(word) || !VERBS.has(word.toLowerCase())) return undefined;
  return {
    running: pad + matchCase(word, gerund(word)) + chain(rest, gerund),
    done: pad + matchCase(word, past(word)) + chain(rest, past),
  };
}
