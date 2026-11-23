// MoPilot 12-Grid Bench (#1381) helpers the F2 forms-and-files tasks share: files in the task folder (by path or by
// bytes), CSV rows, PDFs and PNGs made for fixtures, and the bytes of a download an oracle fetched.
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { pdfDoc } from '../../edgePages.mjs';
import { describeFile, pdfText } from '../files.mjs';
import { same } from '../grade.mjs';

/** @param {Buffer} buf */
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** The SHA-256 of base64 bytes (a stored attachment or upload). @param {string} b64 */
export const sha256Of = (b64) => sha256(Buffer.from(b64, 'base64'));

/** The task folder's entry at a path, compared the way a person reads it (case, spacing, dashes). @param {any} files @param {string} path */
export const fileAt = (files, path) => Object.entries(files.entries).find(([p]) => same(p, path))?.[1];

/** The paths of the folder's files with these bytes under a folder (`dir/`, or '' for anywhere). @param {any} files @param {string} sha @param {string} dir */
export const pathsWithSha = (files, sha, dir) =>
  Object.entries(files.entries)
    .filter(([p, e]) => e.sha256 === sha && p.startsWith(dir))
    .map(([p]) => p);

/** The oracle's file work: a file written into the task folder, as the runner would read it back. @param {any} state @param {string} path @param {Buffer} buf */
export function putFile(state, path, buf) {
  state.files.entries[path] = describeFile(path, buf);
}

/** The bytes of a download the oracle fetched through `browse` (sent as latin1). @param {{ body: string }} res */
export const bodyBytes = (res) => Buffer.from(res.body, 'latin1');

/** A one-page PDF with these lines, as base64 for a fixture attachment. @param {string[]} lines */
export const pdfBase64 = (lines) => Buffer.from(pdfDoc(lines), 'latin1').toString('base64');

/** The text drawn in base64 PDF bytes. @param {string} b64 */
export const pdfTextOf = (b64) => pdfText(Buffer.from(b64, 'base64'));

/** Only the digits of a value (a phone number typed with or without spaces). @param {unknown} s */
export const digits = (s) => String(s).replace(/\D/g, '');

/**
 * The rows of a CSV text: commas separate cells, double quotes wrap a cell (a doubled quote inside is one quote),
 * CRLF or LF ends a row, and blank rows are dropped. Cells are trimmed.
 * @param {unknown} text @returns {string[][]}
 */
export function csvRows(text) {
  /** @type {string[][]} */
  const rows = [];
  let row = /** @type {string[]} */ ([]);
  let cell = '';
  let quoted = false;
  const src = String(text);
  const endRow = () => {
    row.push(cell.trim());
    if (row.some((c) => c)) rows.push(row);
    row = [];
    cell = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n') endRow();
    else if (ch !== '\r') cell += ch;
  }
  endRow();
  return rows;
}

/** A CSV's data rows as objects, when its header is exactly `columns` (any case); otherwise null. @param {unknown} text @param {string[]} columns */
export function csvTable(text, columns) {
  const [head, ...rows] = csvRows(String(text).replace(/^﻿/, ''));
  if (!head || head.length !== columns.length || !columns.every((c, i) => same(head[i], c))) return null;
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])));
}

/** An amount written as a plain decimal ("1234.5", "1234.50"), in cents; null for anything else. @param {unknown} s */
export const plainCents = (s) => (/^\d+(?:\.\d{1,2})?$/.test(String(s)) ? Math.round(Number(s) * 100) : null);

/** A PNG chunk: length, type, data and its CRC. @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A small solid-colour PNG (a phone photo of a receipt stands in as one): valid, so a viewer opens it.
 * @param {number} width @param {number} height @param {[number, number, number]} rgb
 */
export function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const line = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => line));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** "September 2026" for a YYYY-MM month. @param {string} ym */
export const monthName = (ym) =>
  new Date(`${ym}-01T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
