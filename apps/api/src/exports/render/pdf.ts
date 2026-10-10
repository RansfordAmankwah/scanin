import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { metaRows, totalsRows, type ReportModel } from '../model.js';
import { safeCell, safeRow } from '../sanitize.js';

const require = createRequire(import.meta.url);

/**
 * PDFKit's built-in fonts cover only Latin-1, so names would be mangled. Noto Sans (Latin, Greek,
 * Cyrillic and many extended Latin characters) is embedded instead. Scripts that need complex
 * shaping (e.g. Arabic, Indic) are NOT covered; see the risks in the architecture notes.
 */
function fonts(): { regular: string; bold: string } | null {
  try {
    return {
      regular: require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf'),
      bold: require.resolve('@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf'),
    };
  } catch {
    return null;
  }
}

const MARGIN = 36;
const FONT_SIZE = 8.5;
const PAD = 3;

export function renderPdf(model: ReportModel): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: MARGIN,
      bufferPages: true,
      info: {
        Title: `${model.meta.title}: ${model.meta.courseCode} ${model.meta.sessionDate}`,
        Author: 'ScanIn',
        CreationDate: new Date(model.meta.generatedAt),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const f = fonts();
    const regular = f ? 'Body' : 'Helvetica';
    const bold = f ? 'BodyBold' : 'Helvetica-Bold';
    if (f) {
      doc.registerFont('Body', f.regular);
      doc.registerFont('BodyBold', f.bold);
    }

    const width = doc.page.width - MARGIN * 2;

    doc.font(bold).fontSize(16).text(model.meta.title);
    doc.moveDown(0.4);

    // Facts
    doc.fontSize(FONT_SIZE);
    for (const [label, value] of metaRows(model.meta).slice(1)) {
      doc.font(bold).text(`${label}: `, { continued: true }).font(regular).text(safeCell(value));
    }

    // Counts block, clearly separated from the table
    if (model.totals) {
      doc.moveDown(0.8).font(bold).fontSize(11).text('Counts');
      doc.moveDown(0.2).fontSize(FONT_SIZE);
      for (const [label, value] of totalsRows(model.totals)) {
        doc.font(regular).text(`${label}: `, { continued: true }).font(bold).text(String(value));
      }
    }

    // Data table with a repeating header
    const columns = model.table.columns;
    const weights = columns.map((c) =>
      c === 'Full name' || c === 'Class-list match' || c === 'Result'
        ? 2
        : c === 'Student ID' || c === 'Time (UTC)'
          ? 1.4
          : 1,
    );
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * width);

    const rowHeight = (cells: string[]): number =>
      Math.max(
        ...cells.map((cell, i) => doc.heightOfString(cell, { width: widths[i]! - PAD * 2 })),
      ) +
      PAD * 2;

    const drawRow = (cells: string[], y: number, header: boolean): number => {
      const h = rowHeight(cells);
      let x = MARGIN;
      cells.forEach((cell, i) => {
        if (header) doc.rect(x, y, widths[i]!, h).fill('#e6e8ec').fillColor('#000');
        doc.rect(x, y, widths[i]!, h).strokeColor('#b0b5bf').lineWidth(0.5).stroke();
        doc
          .font(header ? bold : regular)
          .fontSize(FONT_SIZE)
          .fillColor('#000')
          .text(cell, x + PAD, y + PAD, { width: widths[i]! - PAD * 2 });
        x += widths[i]!;
      });
      return y + h;
    };

    doc.moveDown(1);
    doc
      .font(bold)
      .fontSize(11)
      .text(model.meta.reportKind === 'ATTENDANCE' ? 'Attendance' : 'Scan history');
    let y = doc.y + 4;
    doc.font(regular).fontSize(FONT_SIZE);
    y = drawRow(columns, y, true);
    for (const row of model.table.rows) {
      const cells = safeRow(row);
      doc.font(regular).fontSize(FONT_SIZE);
      if (y + rowHeight(cells) > doc.page.height - MARGIN - 14) {
        doc.addPage();
        y = MARGIN;
        y = drawRow(columns, y, true);
      }
      y = drawRow(cells, y, false);
    }
    if (model.table.rows.length === 0) {
      doc.font(regular).text('No rows.', MARGIN, y + 6);
    }

    // Page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc
        .font(regular)
        .fontSize(8)
        .fillColor('#555')
        .text(`Page ${i + 1} of ${range.count}`, MARGIN, doc.page.height - MARGIN + 6, {
          width,
          align: 'right',
          lineBreak: false,
        });
    }
    doc.end();
  });
}
