import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** What every export format must reduce to: the same facts, counts and table. */
export interface Parsed {
  facts: Record<string, string>;
  counts: Record<string, number>;
  columns: string[];
  rows: string[][];
}

export function parseCsv(buffer: Buffer): Parsed & { raw: string[][]; hasBom: boolean } {
  const text = buffer.toString('utf8');
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const raw = parse(hasBom ? text.slice(1) : text, { relax_column_count: true }) as string[][];
  const facts: Record<string, string> = {};
  const counts: Record<string, number> = {};
  let i = 0;
  for (; i < raw.length && raw[i]!.length > 0 && !(raw[i]!.length === 1 && raw[i]![0] === ''); i++)
    facts[raw[i]![0]!] = raw[i]![1]!;
  while (raw[i]?.length === 1 && raw[i]![0] === '') i++;
  if (raw[i]?.[0] === 'Counts') {
    i++;
    for (; i < raw.length && raw[i]!.length === 2; i++) counts[raw[i]![0]!] = Number(raw[i]![1]);
    while (raw[i]?.length === 1 && raw[i]![0] === '') i++;
  }
  const columns = raw[i] ?? [];
  const rows = raw.slice(i + 1).filter((r) => !(r.length === 1 && r[0] === ''));
  return { facts, counts, columns, rows, raw, hasBom };
}

export async function parseXlsx(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const summary = wb.getWorksheet('Summary')!;
  const dataSheet = wb.worksheets.find((w) => w.name !== 'Summary')!;
  const facts: Record<string, string> = {};
  const counts: Record<string, number> = {};
  let inCounts = false;
  summary.eachRow((row) => {
    const a = String(row.getCell(1).value ?? '');
    const b = row.getCell(2).value;
    if (a === 'Counts') return void (inCounts = true);
    if (inCounts) counts[a] = Number(b);
    else if (a) facts[a] = String(b ?? '');
  });
  const cells: ExcelJS.Cell[] = [];
  const table: string[][] = [];
  dataSheet.eachRow((row) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      cells.push(cell);
      values.push(cell.value === null || cell.value === undefined ? '' : String(cell.value));
    });
    table.push(values);
  });
  return {
    facts,
    counts,
    columns: table[0] ?? [],
    rows: table.slice(1),
    cells,
    sheetName: dataSheet.name,
    summaryCells: (() => {
      const c: ExcelJS.Cell[] = [];
      summary.eachRow((r) => r.eachCell((cell) => c.push(cell)));
      return c;
    })(),
  };
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export async function parseDocx(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')!.async('string');
  const tables = [...xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map((t) =>
    [...t[1]!.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) =>
      [...r[0].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((c) =>
        unescapeXml([...c[1]!.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')),
      ),
    ),
  );
  const title = unescapeXml(
    [...(xml.match(/<w:p>[\s\S]*?<\/w:p>/)?.[0] ?? '').matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((m) => m[1])
      .join(''),
  );
  return { title, tables, xml, landscape: /w:orient="landscape"/.test(xml) };
}

export async function parsePdf(buffer: Buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((i) => ('str' in i ? i.str : ''))
        .join(' ')
        .replace(/\s+/g, ' '),
    );
  }
  const info = (await doc.getMetadata()).info as { Title?: string; Author?: string };
  return { pages, text: pages.join(' '), pageCount: doc.numPages, info };
}
