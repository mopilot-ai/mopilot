// CSV/TSV and Excel share an accessible scrollable table, worksheet picker and explicit display limits.
import { useState } from 'react';
import { type PreviewSheet, PREVIEW_ROWS, PREVIEW_COLUMNS } from '../../lib/previewTables';
import { withKeys } from '../../lib/listKeys';

export function PreviewTable({ sheets }: { sheets: PreviewSheet[] }) {
  const [selected, setSelected] = useState(0);
  const sheet = sheets[selected];
  if (!sheet) return <div className="empty-state">This workbook has no worksheets.</div>;
  return (
    <div className="file-table-preview">
      {sheets.length > 1 && (
        <label className="preview-toolbar">
          Worksheet{' '}
          <select aria-label="Worksheet" value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
            {sheets.map((s, index) => (
              <option key={s.name} value={index}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {sheet.truncated && (
        <div role="status" className="preview-notice">
          Showing up to {PREVIEW_ROWS.toLocaleString()} rows and {PREVIEW_COLUMNS} columns.
        </div>
      )}
      {sheet.rows.length ? (
        <div className="preview-table-scroll">
          <table aria-label={sheet.name}>
            <tbody>
              {withKeys(sheet.rows, (row) => JSON.stringify(row)).map(({ key, item: row, index }) => (
                <tr key={key}>
                  <th scope="row">{index + 1}</th>
                  {withKeys(row, (text) => text).map(({ key, item }) => (
                    <td key={key}>{item}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">This sheet is empty.</div>
      )}
    </div>
  );
}
