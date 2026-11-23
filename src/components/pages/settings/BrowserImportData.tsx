// Settings → Browser → what imports brought (history and bookmarks per browser, sign-ins per site), each with a way to take it out again. Plain lines, not Settings rows: this page's row budget is full.
import { ownTable } from '../../../../shared/ownTable.mjs';
import { useCallback, useEffect, useState } from 'react';
import { native, type ImportedData } from '../../../lib/native';
import { isEnabled } from '../../../lib/flags';
import { noteIgnored, errorText } from '../../../lib/ignored';
import { toast } from '../../../store/core';
import { pluralize } from '../../../lib/format';

const NAMES: Record<string, string> = ownTable({
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  chromium: 'Chromium',
  vivaldi: 'Vivaldi',
  arc: 'Arc',
  safari: 'Safari',
});
const nameOf = (id: string) => NAMES[id] ?? id;

export function BrowserImportData() {
  return isEnabled('shared.browser.import') ? <ImportedLines /> : null;
}

function ImportedLines() {
  const [data, setData] = useState<ImportedData | null>(null);
  const load = useCallback(() => {
    native.browser.import
      .imported()
      .then(setData)
      .catch((e) => noteIgnored('read what was imported', e));
  }, []);
  useEffect(() => {
    load();
    // a finished import changes what is listed
    return native.browser.import.onProgress(load);
  }, [load]);
  const remove = async (what: string, action: () => Promise<number>) => {
    try {
      await action();
      toast(`Removed imported ${what}`);
    } catch (e) {
      toast(`Couldn't remove imported ${what}: ${errorText(e)}`, 'error');
    }
    load();
  };
  if (!data || !(data.history.length || data.bookmarks.length || data.cookies.length || data.passwords.length)) return null;
  return (
    <div className="import-data" aria-label="Imported browser data">
      {data.history.map((h) => (
        <div key={`h-${h.source}`} className="import-data-line">
          <span>
            Imported history from {nameOf(h.source)}: {pluralize(h.count, 'page')}
          </span>
          <button className="btn-pill soft" onClick={() => remove('history', () => native.browser.import.deleteHistory(h.source))}>
            Delete
          </button>
        </div>
      ))}
      {data.bookmarks.map((b) => (
        <div key={`b-${b.source}`} className="import-data-line">
          <span>
            Imported bookmarks from {nameOf(b.source)}: {b.count}
          </span>
          <button className="btn-pill soft" onClick={() => remove('bookmarks', () => native.browser.import.deleteBookmarks(b.source))}>
            Delete
          </button>
        </div>
      ))}
      {data.passwords.map((p) => (
        <div key={`p-${p.source}`} className="import-data-line">
          <span>
            Imported passwords from {nameOf(p.source)}: {p.count}
          </span>
          <button className="btn-pill soft" onClick={() => remove('passwords', () => native.browser.import.deletePasswords(p.source))}>
            Delete
          </button>
        </div>
      ))}
      {data.cookies.map((c) => (
        <div key={`c-${c.site}`} className="import-data-line">
          <span>
            Signed in to {c.site} from {nameOf(c.source)}: {pluralize(c.count, 'cookie')}
          </span>
          <button
            className="btn-pill soft"
            onClick={() => remove(`sign-in for ${c.site}`, () => native.browser.import.removeCookies(c.site))}
          >
            Remove
          </button>
        </div>
      ))}
      {data.cookies.length > 1 && (
        <div className="import-data-line">
          <span>All imported sign-ins</span>
          <button
            className="btn-pill soft"
            onClick={() =>
              confirm('Remove every sign-in that was imported? You will need to sign in to those sites again.') &&
              remove('sign-ins', () => native.browser.import.removeCookies())
            }
          >
            Remove all
          </button>
        </div>
      )}
    </div>
  );
}
