import { zipSync } from 'fflate';

export type Cell = string | number | null;

const enc = (s: string) => new TextEncoder().encode(s);
const escapeXml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * A minimal .xlsx laid out the way Excel writes one: text in a shared-strings table, numbers as
 * plain values, and empty cells simply left out. Built by hand so the test does not depend on a
 * spreadsheet library.
 */
export function xlsxBytes(rows: Cell[][], sheetName = 'Class list'): Buffer {
  const strings: string[] = [];
  const stringIndex = (s: string) => {
    const i = strings.indexOf(s);
    if (i >= 0) return i;
    strings.push(s);
    return strings.length - 1;
  };

  const sheetRows = rows
    .map((cells, r) => {
      const cs = cells
        .map((value, c) => {
          if (value === null || value === '') return '';
          const ref = `${columnLetters(c)}${r + 1}`;
          return typeof value === 'number'
            ? `<c r="${ref}"><v>${value}</v></c>`
            : `<c r="${ref}" t="s"><v>${stringIndex(value)}</v></c>`;
        })
        .join('');
      return cs ? `<row r="${r + 1}">${cs}</row>` : '';
    })
    .join('');

  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  const zipped = zipSync({
    '[Content_Types].xml': enc(
      `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': enc(
      `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': enc(
      `${xml}<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>` +
        `<sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': enc(
      `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': enc(
      `${xml}<worksheet xmlns="${ns}"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
    'xl/sharedStrings.xml': enc(
      `${xml}<sst xmlns="${ns}" count="${strings.length}" uniqueCount="${strings.length}">` +
        strings.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('') +
        '</sst>',
    ),
  });
  return Buffer.from(zipped);
}
