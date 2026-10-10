import ExcelJS from 'exceljs';
import { metaRows, totalsRows, type ReportModel } from '../model.js';
import { safeCell, safeRow } from '../sanitize.js';

/**
 * Two sheets: "Summary" (facts and counts) and the data table. Every text value is written as a
 * plain string (never as a formula) and guarded by the same sanitiser as the CSV; student IDs stay
 * text so leading zeros survive.
 */
export async function renderXlsx(model: ReportModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ScanIn';
  wb.created = new Date(model.meta.generatedAt);

  const summary = wb.addWorksheet('Summary');
  summary.columns = [{ width: 46 }, { width: 80 }];
  for (const [label, value] of metaRows(model.meta)) {
    const row = summary.addRow([label, safeCell(value)]);
    row.getCell(1).font = { bold: true };
  }
  if (model.totals) {
    summary.addRow([]);
    summary.addRow(['Counts']).getCell(1).font = { bold: true };
    for (const [label, value] of totalsRows(model.totals)) summary.addRow([label, value]); // real numbers
  }

  const data = wb.addWorksheet(
    model.meta.reportKind === 'ATTENDANCE' ? 'Attendance' : 'Scan history',
  );
  data.columns = model.table.columns.map((header) => ({
    header,
    width: Math.max(14, header.length + 4),
  }));
  data.getRow(1).font = { bold: true };
  data.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of model.table.rows) {
    const added = data.addRow(safeRow(row));
    added.eachCell((cell) => {
      cell.numFmt = '@'; // text
    });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
