import { stringify } from 'csv-stringify/sync';
import { metaRows, totalsRows, type ReportModel } from '../model.js';
import { safeCell, safeRow } from '../sanitize.js';

/** Excel needs the byte-order mark to read UTF-8 names correctly. */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * CSV layout: facts, then (for attendance) a labelled counts block, then the table, each separated
 * by a blank line. UTF-8 with a byte-order mark so Excel reads names correctly.
 */
export function renderCsv(model: ReportModel): Buffer {
  const rows: string[][] = [];
  for (const [label, value] of metaRows(model.meta)) rows.push([label, safeCell(value)]);
  rows.push([]);
  if (model.totals) {
    rows.push(['Counts']);
    for (const [label, value] of totalsRows(model.totals)) rows.push([label, String(value)]);
    rows.push([]);
  }
  rows.push(model.table.columns);
  for (const row of model.table.rows) rows.push(safeRow(row));
  const text = stringify(rows, { record_delimiter: '\r\n' });
  return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]);
}
