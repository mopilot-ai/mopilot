// One design system's folder read from disk: its README (title and text), tokens.json, the cards its previews declare,
// the manifest they compile to against the one on disk, and every problem in words. Never writes.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { walk, absentAsNull } = require('./scan.cjs');
const { LIMITS, MANIFEST, parseDsCard, compileManifest, readmeTitle, flattenTokens } = require('../../shared/designSystem.mjs');

/** A preview the checker expects a marker on: an .html file under a preview(s) folder. */
const PREVIEW_DIR = /^(preview|previews)\//;
/** How many preview pages are read at once. */
const HEAD_BATCH = 16;

/**
 * The first `max` bytes of `file` as text, and whether there was more; null when nothing (or a folder) is there. Any
 * other failure (no permission, an I/O error) is thrown, so it is never mistaken for a missing file.
 * @param {string} file
 * @param {number} max
 * @param {typeof fs.promises} [fsp]
 */
async function readHead(file, max, fsp = fs.promises) {
  const fh = await fsp.open(file, 'r').catch(absentAsNull);
  if (!fh) return null;
  try {
    return await readOpen(fh, max).catch(absentAsNull);
  } finally {
    await fh.close();
  }
}

/** The first `max` bytes of an open file. */
async function readOpen(/** @type {import('node:fs/promises').FileHandle} */ fh, /** @type {number} */ max) {
  const { size } = await fh.stat();
  const n = Math.min(size, max);
  const buf = Buffer.alloc(n);
  const { bytesRead } = await fh.read(buf, 0, n, 0);
  return { text: buf.subarray(0, bytesRead).toString('utf8'), clipped: size > max, size };
}

/** tokens.json as parsed, or why it can't be used. */
function parseTokens(/** @type {{ text: string, clipped: boolean } | null} */ read) {
  if (!read) return { ok: false, problem: 'tokens.json is missing: it holds the exact token values (colors, type, spacing).' };
  if (read.clipped) return { ok: false, problem: `tokens.json is larger than ${LIMITS.tokens} bytes, so it was not read.` };
  let json;
  try {
    json = JSON.parse(read.text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, problem: `tokens.json is not valid JSON (${/** @type {Error} */ (e).message}).` };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json))
    return { ok: false, problem: 'tokens.json must be a JSON object of tokens (DTCG groups or name -> value).' };
  if (!flattenTokens(json).length) return { ok: false, json, problem: 'tokens.json has no tokens in it.' };
  return { ok: true, json, problem: null };
}

/**
 * Reads the system at `root` (an existing folder, by its real path).
 * @param {string} root
 * @param {{ fsp?: typeof fs.promises }} [o]
 */
async function readSystem(root, o = {}) {
  const fsp = o.fsp ?? fs.promises;
  const { files, truncated, unreadable } = await walk(root, { fsp });
  /** @type {string[]} */
  const problems = [];
  const readme = await readHead(path.join(root, 'README.md'), LIMITS.readme, fsp);
  const title = readme ? readmeTitle(readme.text) : null;
  if (!readme) problems.push('README.md is missing: it is the guide (a "# Name" title, how to use the system, an Index of its cards).');
  else if (!title) problems.push('README.md has no "# Name" title line.');
  const tokens = parseTokens(await readHead(path.join(root, 'tokens.json'), LIMITS.tokens, fsp));
  if (tokens.problem) problems.push(tokens.problem);
  if (!files.includes('api/tokens.md')) problems.push('api/tokens.md is missing (recommended: the palette, type and fonts in prose).');

  const cards = [];
  const pages = files.filter((rel) => /\.html?$/i.test(rel));
  /** each page's first bytes, read a batch at a time */
  const heads = [];
  for (let i = 0; i < pages.length; i += HEAD_BATCH)
    heads.push(...(await Promise.all(pages.slice(i, i + HEAD_BATCH).map((rel) => readHead(path.join(root, rel), 2048, fsp)))));
  for (const [i, rel] of pages.entries()) {
    const head = heads[i];
    const card = head ? parseDsCard(head.text) : null;
    if (!card) {
      if (PREVIEW_DIR.test(rel)) problems.push(`${rel} has no <!-- @dsCard group="…" --> marker on its first line, so it is not a card.`);
      continue;
    }
    if (!card.group) problems.push(`${rel}: its @dsCard marker has no group="…".`);
    else cards.push({ path: rel, ...card });
  }
  const manifest = compileManifest(cards);
  const manifestState = await manifestOnDisk(path.join(root, MANIFEST), manifest, fsp);
  if (manifestState === 'invalid') problems.push(`${MANIFEST} is not valid JSON: compile it again with design_system_compile.`);
  else if (manifestState === 'stale') problems.push(`${MANIFEST} is out of date with the cards: compile it with design_system_compile.`);
  else if (manifestState === 'missing' && cards.length) problems.push(`${MANIFEST} is missing: compile it with design_system_compile.`);
  for (const dir of unreadable) problems.push(`The folder ${dir || '.'} could not be read, so its files are left out.`);
  if (truncated)
    problems.push(`The folder has more than ${LIMITS.files} files or folders deeper than ${LIMITS.depth}; only the first were read.`);
  return {
    root,
    slug: path.basename(root),
    name: title ?? path.basename(root),
    readme: readme ? { text: readme.text, clipped: readme.clipped } : null,
    tokens,
    files,
    cards: manifest.cards,
    manifest,
    manifestState,
    problems,
  };
}

/**
 * The manifest on disk against the compiled one.
 * @returns {Promise<'missing' | 'invalid' | 'stale' | 'current'>}
 */
async function manifestOnDisk(file, compiled, fsp) {
  const read = await readHead(file, LIMITS.file * 4, fsp);
  if (!read) return 'missing';
  try {
    return JSON.stringify(JSON.parse(read.text)) === JSON.stringify(compiled) ? 'current' : 'stale';
  } catch {
    return 'invalid';
  }
}

module.exports = { readSystem, readHead, parseTokens };
