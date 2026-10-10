import type { ReportModel } from '../model.js';
import { renderCsv } from './csv.js';
import { renderDocx } from './docx.js';
import { renderPdf } from './pdf.js';
import { renderXlsx } from './xlsx.js';

export type ExportFormat = 'CSV' | 'XLSX' | 'PDF' | 'DOCX';

export const FORMATS: Record<ExportFormat, { ext: string; contentType: string }> = {
  CSV: { ext: 'csv', contentType: 'text/csv; charset=utf-8' },
  XLSX: {
    ext: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  PDF: { ext: 'pdf', contentType: 'application/pdf' },
  DOCX: {
    ext: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
};

/** Renders the shared report model. Pure: no database, no clock, no side effects. */
export async function render(format: ExportFormat, model: ReportModel): Promise<Buffer> {
  switch (format) {
    case 'CSV':
      return renderCsv(model);
    case 'XLSX':
      return renderXlsx(model);
    case 'PDF':
      return renderPdf(model);
    case 'DOCX':
      return renderDocx(model);
  }
}
