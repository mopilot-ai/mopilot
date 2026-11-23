// The bin folders of Node version managers (nvm, fnm, mise), read from their own folders as their shell hooks
// would, without running anything: the Node a terminal gets by default, and every installed Node newest first.
// A CLI installed with `npm i -g` under one of them lives in that Node's bin folder. Used by userTools.cjs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

/** Whether `p` is a folder (false when it is missing). */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (error) {
    noteIgnored('look at a Node version folder', error, ['ENOENT', 'ENOTDIR', 'EACCES']);
    return false;
  }
}

/** v22.12.0, 22.12.0 or 22 (a partial version) as numbers and how many parts it has; null for a name that is none. */
function parseNodeVersion(name) {
  const parts = String(name).replace(/^v/, '').split('.');
  if (parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  return { v: [n[0], n[1] ?? 0, n[2] ?? 0], parts: parts.length };
}

/** Higher version first, by number (v22 before v9); a name that is no version (mise's "lts") after every one. */
function newestFirst(a, b) {
  const x = parseNodeVersion(a);
  const y = parseNodeVersion(b);
  if (!x || !y) return x ? -1 : y ? 1 : a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) if (x.v[i] !== y.v[i]) return y.v[i] - x.v[i];
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The names of the version folders under `root` that have `sub` (root/<version>/<sub>), newest first. */
function nodeVersions(root, sub) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    noteIgnored('list the installed Node versions', error, ['ENOENT', 'ENOTDIR', 'EACCES']);
    return [];
  }
  return names.filter((n) => isDir(path.join(root, n, sub))).sort(newestFirst);
}

/** What nvm's alias `name` holds: the first non-blank line of alias/<name>, with lts/-N read as nvm reads it. */
function nvmAlias(aliasDir, name) {
  const back = /^lts\/-(\d+)$/.exec(name);
  if (back) {
    let lines = [];
    try {
      lines = fs.readdirSync(path.join(aliasDir, 'lts')).sort();
    } catch (error) {
      noteIgnored("list nvm's LTS aliases", error, ['ENOENT', 'ENOTDIR']);
    }
    const k = Number(back[1]);
    const pick = lines[Math.max(0, lines.length - (k + 1))];
    if (!k || !pick || pick === '*') return '';
    name = `lts/${pick}`;
  }
  if (!name || name.includes('..')) return '';
  try {
    const text = fs.readFileSync(path.join(aliasDir, ...name.split('/')), 'utf8');
    return (
      text
        .split('\n')
        .find((l) => l.trim())
        ?.trim() ?? ''
    );
  } catch (error) {
    noteIgnored('read an nvm alias', error, ['ENOENT', 'ENOTDIR', 'EISDIR']);
    return '';
  }
}

/**
 * The installed version nvm's default alias resolves to, as nvm.sh does when a shell loads it: alias/default, then each
 * alias it names (lts/* → lts/jod → v22.20.0), a cycle being none; node/stable the newest; a partial version (22) the
 * newest it starts; a full one itself when installed. `system` says the default is the system's Node (no nvm folder).
 * @param {string} dir nvm's folder
 * @param {string[]} names the installed versions, newest first
 * @returns {{ version: string | null, system: boolean }}
 */
function nvmDefault(dir, names) {
  const aliasDir = path.join(dir, 'alias');
  let cur = 'default';
  const seen = new Set([cur]);
  for (let next = nvmAlias(aliasDir, cur); next; next = nvmAlias(aliasDir, cur)) {
    if (seen.has(next)) return { version: null, system: false };
    seen.add(next);
    cur = next;
  }
  if (cur === 'default') return { version: null, system: false };
  if (cur === 'system') return { version: null, system: true };
  if (cur === 'node' || cur === 'stable')
    return { version: names.find((n) => n.startsWith('v') && parseNodeVersion(n)) ?? null, system: false };
  if (/^\d/.test(cur)) cur = `v${cur}`;
  const parsed = parseNodeVersion(cur);
  if (!parsed || !cur.startsWith('v')) return { version: null, system: false };
  if (parsed.parts === 3) return { version: names.includes(cur) ? cur : null, system: false };
  const prefix = `${cur.replace(/\.$/, '')}.`;
  return { version: names.find((n) => n.startsWith(prefix)) ?? null, system: false };
}

/**
 * nvm's Node bin folders: `def` is the one a terminal gets (its default, else the newest when the default is unset,
 * none when it is the system's Node); `all` every installed one, the default first.
 * @param {string} dir nvm's folder
 */
function nvmBins(dir) {
  const root = path.join(dir, 'versions', 'node');
  const names = nodeVersions(root, 'bin');
  const { version, system } = nvmDefault(dir, names);
  const bin = (n) => path.join(root, n, 'bin');
  const all = names.map(bin);
  const def = version ? bin(version) : !system && all.length ? all[0] : null;
  return { def, all: def ? [def, ...all.filter((b) => b !== def)] : all };
}

/** fnm's Node bin folders: its default alias's (aliases/default, a link to the version) first, then newest first. */
function fnmBins(dir) {
  const root = path.join(dir, 'node-versions');
  const all = nodeVersions(root, path.join('installation', 'bin')).map((n) => path.join(root, n, 'installation', 'bin'));
  /** @type {string | null} */
  let def = null;
  try {
    const to = fs.realpathSync(path.join(dir, 'aliases', 'default'));
    const rel = path.relative(fs.realpathSync(root), to);
    const bin = path.join(root, rel, 'bin');
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && isDir(bin)) def = bin;
  } catch (error) {
    noteIgnored("resolve fnm's default Node", error, ['ENOENT', 'ENOTDIR']);
  }
  return { def, all: def ? [def, ...all.filter((b) => b !== def)] : all };
}

/** The bin folders of a manager that keeps each version as root/<version>/bin (mise's installs), newest first. */
const nodeBins = (root) => nodeVersions(root, 'bin').map((n) => path.join(root, n, 'bin'));

module.exports = { parseNodeVersion, newestFirst, nodeVersions, nvmAlias, nvmDefault, nvmBins, fnmBins, nodeBins, isDir };
