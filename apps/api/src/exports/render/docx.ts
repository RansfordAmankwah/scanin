import {
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { metaRows, totalsRows, type ReportModel } from '../model.js';
import { safeCell, safeRow } from '../sanitize.js';

const cell = (text: string, opts: { bold?: boolean } = {}): TableCell =>
  new TableCell({
    children: [
      new Paragraph({ children: [new TextRun({ text, bold: opts.bold === true, size: 18 })] }),
    ],
  });

const row = (cells: string[], header = false): TableRow =>
  new TableRow({ tableHeader: header, children: cells.map((c) => cell(c, { bold: header })) });

const table = (rows: TableRow[]): Table =>
  new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });

/** Word document with the same facts, counts and table as every other format. */
export async function renderDocx(model: ReportModel): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({ text: model.meta.title, heading: HeadingLevel.HEADING_1 }),
    table(
      metaRows(model.meta)
        .slice(1)
        .map(([label, value]) => row([label, safeCell(value)])),
    ),
  ];

  if (model.totals) {
    children.push(new Paragraph({ text: 'Counts', heading: HeadingLevel.HEADING_2 }));
    children.push(
      table(totalsRows(model.totals).map(([label, value]) => row([label, String(value)]))),
    );
  }

  children.push(
    new Paragraph({
      text: model.meta.reportKind === 'ATTENDANCE' ? 'Attendance' : 'Scan history',
      heading: HeadingLevel.HEADING_2,
    }),
  );
  children.push(
    table([row(model.table.columns, true), ...model.table.rows.map((r) => row(safeRow(r)))]),
  );

  const doc = new Document({
    creator: 'ScanIn',
    title: `${model.meta.title}: ${model.meta.courseCode} ${model.meta.sessionDate}`,
    sections: [
      { properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } }, children },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
