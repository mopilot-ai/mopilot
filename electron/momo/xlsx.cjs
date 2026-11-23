// MoMo's momo_save_sheet builds its .xlsx here (#2139 Outputs): one sheet from rows of strings, numbers and booleans, written with SheetJS (the `xlsx` package, loaded only when a sheet is saved). The caller (the model) never sends binary: it sends rows, and the row, column and cell limits are checked first. Every string stays a text cell (aoa_to_sheet makes no formula from text), so text starting with = + - or @ is shown as text and never run.
const MAX_ROWS = 5000;
const MAX_COLS = 100;
const MAX_CELL = 5000;
/** The build is synchronous in main: cells and text are bounded first, so the longest one takes about a tenth of a second (500,000 cells took 3.7 s). */
const MAX_CELLS = 20_000;
const MAX_CHARS = 500_000;
const MAX_SHEET_NAME = 31;

class SheetError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.code = 'bad_rows';
  }
}

// characters XML 1.0 can't carry, and lone surrogates
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The sheet name as Excel allows it: no [ ] : * ? / \, at most 31 characters, "Sheet1" when nothing is left. */
function sheetName(/** @type {unknown} */ raw) {
  const name = (typeof raw === 'string' ? raw : '')
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(INVALID_XML, '')
    .trim()
    .slice(0, MAX_SHEET_NAME)
    // SheetJS refuses a name that starts or ends with an apostrophe, and "History" (Excel keeps it for itself)
    .replace(/^['\s]+|['\s]+$/g, '');
  if (!name) return 'Sheet1';
  return name.toLowerCase() === 'history' ? `${name} 1` : name;
}

/**
 * The bytes of an .xlsx with one sheet. Throws a SheetError (code bad_rows) saying what to fix.
 * @param {unknown} rows an array of arrays of string, finite number, boolean or null
 * @param {unknown} [name] the sheet's name
 * @returns {Buffer}
 */
function buildXlsx(rows, name) {
  if (!Array.isArray(rows) || !rows.length) throw new SheetError('rows must be a non-empty array of rows, each an array of cells');
  if (rows.length > MAX_ROWS) throw new SheetError(`At most ${MAX_ROWS} rows.`);
  let cells = 0;
  let chars = 0;
  const clean = rows.map((row, r) => {
    if (!Array.isArray(row)) throw new SheetError(`Row ${r + 1} must be an array of cells.`);
    if (row.length > MAX_COLS) throw new SheetError(`At most ${MAX_COLS} columns.`);
    cells += row.length;
    if (cells > MAX_CELLS) throw new SheetError(`At most ${MAX_CELLS} cells in all; for more data save a CSV with momo_save_file.`);
    return row.map((cell, c) => {
      if (cell === null || cell === undefined || cell === '') return null;
      if (typeof cell === 'string') {
        if (cell.length > MAX_CELL) throw new SheetError(`A cell is longer than ${MAX_CELL} characters (row ${r + 1}, column ${c + 1}).`);
        chars += cell.length;
        if (chars > MAX_CHARS)
          throw new SheetError(`At most ${MAX_CHARS} characters of text in all; for more data save a CSV with momo_save_file.`);
        return cell.replace(INVALID_XML, '');
      }
      if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
      if (typeof cell === 'boolean') return cell;
      throw new SheetError(`The cell in row ${r + 1}, column ${c + 1} must be a string, a number, a boolean or null.`);
    });
  });
  // loaded here, not at startup: most runs never save a sheet
  const XLSX = require('xlsx');
  try {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(clean), sheetName(name));
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  } catch (e) {
    // whatever the library refuses, the model is told in the tool's own terms
    throw new SheetError(
      `The spreadsheet could not be built (${String(/** @type {any} */ (e)?.message ?? e).slice(0, 120)}); check the rows and the sheet name.`,
    );
  }
}

module.exports = { buildXlsx, SheetError, sheetName, MAX_ROWS, MAX_COLS, MAX_CELL, MAX_CELLS, MAX_CHARS };
