// Release bookkeeping for the phone app: `node scripts/release.mjs show | bump [--version x.y.z] [--build n] | check [--against <git ref>]`, run as `npm run release:show|bump|check`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { bump, follows, validate } = require('../config/version.js');

const MOBILE = fileURLToPath(new URL('..', import.meta.url));
/** Files a store upload reads, which must hold no `<PLACEHOLDER>` (mobile/store/README.md lists them). */
const STORE_METADATA = 'store/metadata';
/** Images a store build needs that are not derived at build time. */
const STORE_GRAPHICS = ['store/graphics/play-store-icon.png', 'store/graphics/play-feature-graphic.png'];

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function filesUnder(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, found);
    else found.push(path);
  }
  return found;
}

/** Everything `release check` finds wrong, as sentences; empty when the tree is ready to build a store release. */
export function problems({ root = MOBILE, against, git = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' }) } = {}) {
  const found = [];
  let record;
  try {
    record = validate(readJson(join(root, 'config/version.json')));
  } catch (error) {
    return [`config/version.json: ${error.message}`];
  }
  for (const file of ['package.json', 'package-lock.json']) {
    const v = readJson(join(root, file));
    if (v.version !== record.version) found.push(`${file} says ${v.version} but config/version.json says ${record.version}; run npm run release:bump`);
    if (file === 'package-lock.json' && v.packages?.['']?.version !== record.version) found.push('package-lock.json packages[""] disagrees with config/version.json');
  }
  if (against) {
    try {
      const base = validate(JSON.parse(git(against, 'mobile/config/version.json')));
      if (!follows(base, record)) found.push(`config/version.json (${record.version} build ${record.buildNumber}) does not follow ${against} (${base.version} build ${base.buildNumber}): the build number must rise`);
    } catch (error) {
      found.push(`cannot read the version on ${against}: ${error.message.split('\n')[0]}`);
    }
  }
  const metadata = join(root, STORE_METADATA);
  if (!existsSync(metadata)) found.push(`${STORE_METADATA} is missing`);
  else {
    for (const file of filesUnder(metadata)) {
      const left = [...new Set(readFileSync(file, 'utf8').match(/<[A-Z][A-Z_]+>/g) ?? [])];
      if (left.length) found.push(`${relative(root, file)} still has ${left.join(', ')}`);
    }
  }
  for (const graphic of STORE_GRAPHICS) if (!existsSync(join(root, graphic))) found.push(`${graphic} is missing; run npm run icons`);
  return found;
}

/**
 * @param {string[]} argv
 * @param {{ root?: string, out?: (line: string) => void, git?: (ref: string, file: string) => string }} [io]
 * @returns {number} the exit status
 */
export function main(argv, { root = MOBILE, out = console.log, git } = {}) {
  try {
    return run(argv, root, out, git);
  } catch (error) {
    out(`release.mjs: ${error.message}`);
    return 1;
  }
}

function run(argv, root, out, git) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { version: { type: 'string' }, build: { type: 'string' }, against: { type: 'string' } } });
  const [command] = positionals;
  const file = join(root, 'config/version.json');
  if (command === 'show') {
    const { version, buildNumber } = validate(readJson(file));
    out(`${version} (${buildNumber})`);
    return 0;
  }
  if (command === 'bump') {
    // everything is read and checked before anything is written, so a failure leaves the three files as they were
    const build = values.build === undefined ? undefined : Number(values.build);
    const next = bump(validate(readJson(file)), values.version, build);
    const pkg = readJson(join(root, 'package.json'));
    const lock = readJson(join(root, 'package-lock.json'));
    lock.version = next.version;
    if (lock.packages?.['']) lock.packages[''].version = next.version;
    writeJson(file, next);
    writeJson(join(root, 'package.json'), { ...pkg, version: next.version });
    writeJson(join(root, 'package-lock.json'), lock);
    out(`${next.version} (${next.buildNumber})`);
    return 0;
  }
  if (command === 'check') {
    const found = problems({ root, against: values.against, ...(git && { git }) });
    for (const line of found) out(line);
    if (!found.length) out('ready');
    return found.length ? 1 : 0;
  }
  out('usage: release.mjs show | bump [--version x.y.z] [--build n] | check [--against <git ref>]');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
