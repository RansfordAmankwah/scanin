import { unzipSync } from 'fflate';

/**
 * Turns whatever a lecturer has (an Excel workbook, a CSV in any common encoding, tab- or
 * semicolon-separated text copied from a spreadsheet) into the plain comma-separated text the
 * server already validates. The server's strict CSV parser stays the only thing that decides
 * whether a class list is acceptable; nothing here guesses at columns.
 */

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** What one decompressed workbook part may expand to. Stops a zip bomb from freezing the tab. */
const MAX_PART_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 100;

export type FileProblem =
  'TOO_BIG' | 'UNSUPPORTED_EXCEL_OLD' | 'UNSUPPORTED' | 'UNREADABLE' | 'EMPTY' | 'TOO_MANY_ROWS';

export type ConvertedFile =
  { ok: true; csv: string; note: string } | { ok: false; code: FileProblem };

/* ----------------------------------------------------------------------------------------------
 * Text
 * ------------------------------------------------------------------------------------------- */

/** UTF-8 (with or without a byte-order mark), UTF-16, or the Windows-1252 that Excel's plain "CSV" uses. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const CANDIDATES = [',', ';', '\t'] as const;

function firstLine(text: string): string {
  for (const line of text.split(/\r\n|\n|\r/)) if (line.trim()) return line;
  return '';
}

/** The delimiter used by the header line, ignoring anything inside quotes. Comma wins ties. */
function detectDelimiter(text: string): (typeof CANDIDATES)[number] {
  const counts = new Map<string, number>(CANDIDATES.map((c) => [c, 0]));
  let quoted = false;
  for (const ch of firstLine(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best: (typeof CANDIDATES)[number] = ',';
  for (const c of CANDIDATES) if ((counts.get(c) ?? 0) > (counts.get(best) ?? 0)) best = c;
  return best;
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const needsQuotes = /[",\r\n]/;
const LINE_BREAK = String.fromCharCode(10);

/**
 * Serialises rows as comma-separated text. Spreadsheets leave trailing empty cells out, but the
 * server requires every row to have the same number of columns, so rows are padded to one width.
 * Blank rows stay blank lines, which keeps line numbers equal to spreadsheet row numbers.
 */
export function rowsToCsv(rows: string[][]): string {
  const isBlank = (r: string[]) => r.every((c) => c.trim() === '');
  const width = Math.max(0, ...rows.filter((r) => !isBlank(r)).map((r) => r.length));
  const line = (r: string[]) =>
    Array.from({ length: width }, (_, i) => {
      const c = r[i] ?? '';
      return needsQuotes.test(c) ? `"${c.replaceAll('"', '""')}"` : c;
    }).join(',');
  return rows.map((r) => (isBlank(r) ? '' : line(r))).join(LINE_BREAK) + LINE_BREAK;
}

/**
 * Text that is already comma-separated is returned untouched. Tab-separated (what Excel and Google
 * Sheets put on the clipboard) and semicolon-separated (Excel in many European locales) text is
 * rewritten as comma-separated.
 */
export function normalizeDelimited(text: string): string {
  const delimiter = detectDelimiter(text);
  if (delimiter === ',') return text;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return rowsToCsv(parseDelimited(body, delimiter));
}

/* ----------------------------------------------------------------------------------------------
 * Excel (.xlsx): a zip of XML parts
 * ------------------------------------------------------------------------------------------- */

const parseXml = (bytes: Uint8Array): Document =>
  new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');

const localName = (el: Element) => el.localName;

function childrenNamed(parent: Element | Document, name: string): Element[] {
  return Array.from(parent.getElementsByTagName('*')).filter((e) => localName(e) === name);
}

/** Visible text of a shared or inline string, ignoring phonetic (furigana) runs. */
function stringText(si: Element): string {
  return childrenNamed(si, 't')
    .filter((t) => t.parentElement && localName(t.parentElement) !== 'rPh')
    .map((t) => t.textContent ?? '')
    .join('');
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel stores numbers as text like "1.2345E+4"; show them the way a person typed them. */
function numberText(raw: string): string {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) ? String(n) : raw;
}

function sheetNameAndPath(
  files: Record<string, Uint8Array>,
): { name: string; path: string; count: number } | null {
  const wbBytes = files['xl/workbook.xml'];
  const relBytes = files['xl/_rels/workbook.xml.rels'];
  if (!wbBytes || !relBytes) return null;
  const sheets = childrenNamed(parseXml(wbBytes), 'sheet');
  const visible = sheets.filter(
    (s) => !['hidden', 'veryHidden'].includes(s.getAttribute('state') ?? ''),
  );
  const first = visible[0];
  if (!first) return null;
  // The relationship id lives in the "r:" namespace; match it by local name.
  const rid = Array.from(first.attributes).find((a) => a.localName === 'id')?.value;
  const rel = childrenNamed(parseXml(relBytes), 'Relationship').find(
    (r) => r.getAttribute('Id') === rid,
  );
  const target = rel?.getAttribute('Target');
  if (!target) return null;
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  return { name: first.getAttribute('name') ?? '', path, count: visible.length };
}

function readWorkbook(bytes: Uint8Array): { rows: string[][]; sheet: string; sheets: number } {
  const wanted = (name: string) =>
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    name === 'xl/sharedStrings.xml' ||
    /^xl\/worksheets\/[^/]+\.xml$/.test(name);
  const files = unzipSync(bytes, {
    filter: (f) => wanted(f.name) && f.originalSize <= MAX_PART_BYTES,
  });

  const located = sheetNameAndPath(files);
  const sheetBytes = located && files[located.path];
  if (!located || !sheetBytes) throw new Error('not a workbook');

  const shared = files['xl/sharedStrings.xml']
    ? childrenNamed(parseXml(files['xl/sharedStrings.xml']), 'si').map(stringText)
    : [];

  const rows: string[][] = [];
  for (const row of childrenNamed(parseXml(sheetBytes), 'row')) {
    const rowIndex = Number(row.getAttribute('r')) - 1;
    if (!Number.isInteger(rowIndex) || rowIndex < 0) continue;
    if (rowIndex >= MAX_ROWS) throw new RangeError('TOO_MANY_ROWS');
    const cells: string[] = [];
    for (const c of Array.from(row.children).filter((e) => localName(e) === 'c')) {
      const col = columnIndex(c.getAttribute('r') ?? '');
      if (col < 0 || col >= MAX_COLUMNS) continue;
      const v = Array.from(c.children).find((e) => localName(e) === 'v')?.textContent ?? '';
      let value: string;
      switch (c.getAttribute('t')) {
        case 's':
          value = shared[Number(v)] ?? '';
          break;
        case 'inlineStr': {
          const is = Array.from(c.children).find((e) => localName(e) === 'is');
          value = is ? stringText(is) : '';
          break;
        }
        case 'b':
          value = v === '1' ? 'TRUE' : 'FALSE';
          break;
        case 'str':
        case 'd':
        case 'e':
          value = v;
          break;
        default:
          value = numberText(v);
      }
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    while (rows.length < rowIndex) rows.push([]); // keep spreadsheet row numbers = line numbers
    rows[rowIndex] = cells;
  }
  return { rows, sheet: located.name, sheets: located.count };
}

/* ----------------------------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------------------------- */

const startsWith = (b: Uint8Array, ...sig: number[]) => sig.every((v, i) => b[i] === v);
const UNSUPPORTED_EXTENSIONS = /\.(ods|numbers|pdf|docx?|pages|odt|zip|png|jpe?g)$/i;

export async function fileToCsv(file: File): Promise<ConvertedFile> {
  if (file.size > MAX_FILE_BYTES) return { ok: false, code: 'TOO_BIG' };
  if (UNSUPPORTED_EXTENSIONS.test(file.name)) return { ok: false, code: 'UNSUPPORTED' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) return { ok: false, code: 'EMPTY' };

  if (startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0))
    return { ok: false, code: 'UNSUPPORTED_EXCEL_OLD' };
  if (startsWith(bytes, 0x25, 0x50, 0x44, 0x46)) return { ok: false, code: 'UNSUPPORTED' }; // %PDF

  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) {
    try {
      const { rows, sheet, sheets } = readWorkbook(bytes);
      if (rows.every((r) => r.every((c) => c.trim() === ''))) return { ok: false, code: 'EMPTY' };
      const used = rows.filter((r) => r.some((c) => c.trim() !== '')).length;
      const more =
        sheets > 1 ? ` (the workbook has ${sheets} sheets; only the first was read)` : '';
      return {
        ok: true,
        csv: rowsToCsv(rows),
        note: `Read ${used} rows from sheet "${sheet}"${more}.`,
      };
    } catch (err) {
      if (err instanceof RangeError) return { ok: false, code: 'TOO_MANY_ROWS' };
      return { ok: false, code: 'UNREADABLE' };
    }
  }

  const text = decodeText(bytes);
  if (!text.trim()) return { ok: false, code: 'EMPTY' };
  return { ok: true, csv: normalizeDelimited(text), note: 'File read.' };
}
