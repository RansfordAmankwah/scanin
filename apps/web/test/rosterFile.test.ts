import ExcelJS from 'exceljs';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  decodeText,
  fileToCsv,
  MAX_FILE_BYTES,
  normalizeDelimited,
} from '../src/features/lecturer/rosterFile';

const file = (data: string | Uint8Array, name: string) =>
  new File([typeof data === 'string' ? data : new Uint8Array(data)], name);
const bytes = (...b: number[]) => new Uint8Array(b);

async function workbook(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('normalizeDelimited', () => {
  it('leaves comma-separated text exactly as it was', () => {
    const csv = 'student_id,full_name\r\nA1,"Smith, Ann"\r\n';
    expect(normalizeDelimited(csv)).toBe(csv);
  });

  it('rewrites tab-separated text (what Excel puts on the clipboard) as comma-separated', () => {
    expect(normalizeDelimited('student_id\tfull_name\temail\nA1\tAnn Smith\ta@s.test\n')).toBe(
      'student_id,full_name,email\nA1,Ann Smith,a@s.test\n',
    );
  });

  it('rewrites semicolon-separated text (Excel in many locales) and quotes what needs it', () => {
    expect(normalizeDelimited('student_id;full_name\nA1;"Smith, Ann"\nA2;He said "hi"\n')).toBe(
      'student_id,full_name\nA1,"Smith, Ann"\nA2,"He said ""hi"""\n',
    );
  });

  it('keeps a delimiter that appears inside quotes, and a byte-order mark does not confuse it', () => {
    expect(normalizeDelimited('﻿student_id\tfull_name\nA1\t"Ann\tSmith"\n')).toBe(
      'student_id,full_name\nA1,Ann\tSmith\n',
    );
  });

  it('pads short rows so every row has the same number of columns', () => {
    expect(normalizeDelimited('student_id\tfull_name\temail\nA1\tAnn\nA2\tBob\tb@s.test\n')).toBe(
      'student_id,full_name,email\nA1,Ann,\nA2,Bob,b@s.test\n',
    );
  });
});

describe('decodeText', () => {
  it('reads UTF-8, Windows-1252 (Excel plain CSV) and UTF-16', () => {
    expect(decodeText(new TextEncoder().encode('Zoë'))).toBe('Zoë');
    expect(decodeText(bytes(0x5a, 0x6f, 0xeb))).toBe('Zoë'); // 0xEB is "ë" in Windows-1252, invalid in UTF-8
    expect(decodeText(bytes(0xff, 0xfe, 0x5a, 0x00, 0xeb, 0x00))).toBe('Zë');
  });
});

describe('fileToCsv: Excel workbooks', () => {
  it('reads the first sheet, keeps text IDs and leading zeros, and writes numbers plainly', async () => {
    const data = await workbook((wb) => {
      const ws = wb.addWorksheet('Class');
      ws.addRow(['student_id', 'full_name', 'email']);
      ws.addRow(['00123', 'Ann "AJ" Smith', 'ann@s.test']);
      ws.addRow([4567, 'Bob, Jr.']); // a numeric cell, and an e-mail cell left out entirely
      ws.addRow([]);
      ws.addRow(['A9', 'Zoë Müller', 'zoe@s.test']);
      wb.addWorksheet('Notes').addRow(['ignore me']);
    });
    const out = await fileToCsv(file(data, 'class.xlsx'));
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.csv).toBe(
      [
        'student_id,full_name,email',
        '00123,"Ann ""AJ"" Smith",ann@s.test',
        '4567,"Bob, Jr.",',
        '',
        'A9,Zoë Müller,zoe@s.test',
        '',
      ].join('\n'),
    );
    expect(out.note).toContain('"Class"');
    expect(out.note).toContain('2 sheets');
  });

  it('skips a hidden first sheet', async () => {
    const data = await workbook((wb) => {
      const hidden = wb.addWorksheet('Hidden', { state: 'hidden' });
      hidden.addRow(['secret']);
      wb.addWorksheet('Visible').addRow(['student_id', 'full_name']);
    });
    const out = await fileToCsv(file(data, 'x.xlsx'));
    expect(out.ok && out.csv).toBe('student_id,full_name\n');
  });

  it('reads a workbook whose extension is wrong, by its contents', async () => {
    const data = await workbook((wb) => wb.addWorksheet('S').addRow(['student_id', 'full_name']));
    expect(await fileToCsv(file(data, 'class-list'))).toMatchObject({ ok: true });
  });

  it('reports an empty workbook', async () => {
    const data = await workbook((wb) => wb.addWorksheet('Empty'));
    expect(await fileToCsv(file(data, 'empty.xlsx'))).toEqual({ ok: false, code: 'EMPTY' });
  });
});

describe('fileToCsv: text files', () => {
  it('reads CSV, TSV and semicolon files, in UTF-8 or Windows-1252', async () => {
    expect(await fileToCsv(file('student_id,full_name\nA1,Ann\n', 'a.csv'))).toMatchObject({
      ok: true,
      csv: 'student_id,full_name\nA1,Ann\n',
    });
    expect(await fileToCsv(file('student_id\tfull_name\nA1\tAnn\n', 'a.tsv'))).toMatchObject({
      ok: true,
      csv: 'student_id,full_name\nA1,Ann\n',
    });
    const latin = new Uint8Array([
      ...new TextEncoder().encode('student_id;full_name\nA1;Zo'),
      0xeb,
      0x0a,
    ]);
    expect(await fileToCsv(file(latin, 'latin.csv'))).toMatchObject({
      ok: true,
      csv: 'student_id,full_name\nA1,Zoë\n',
    });
  });
});

describe('fileToCsv: things it cannot or will not read', () => {
  it('explains old .xls, other formats, empty and oversized files', async () => {
    expect(await fileToCsv(file(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1), 'old.xls'))).toEqual({
      ok: false,
      code: 'UNSUPPORTED_EXCEL_OLD',
    });
    expect(await fileToCsv(file('%PDF-1.7', 'list.txt'))).toEqual({
      ok: false,
      code: 'UNSUPPORTED',
    });
    expect(await fileToCsv(file('x', 'sheet.ods'))).toEqual({ ok: false, code: 'UNSUPPORTED' });
    expect(await fileToCsv(file('', 'empty.csv'))).toEqual({ ok: false, code: 'EMPTY' });
    expect(await fileToCsv(file('   \n', 'blank.csv'))).toEqual({ ok: false, code: 'EMPTY' });
    expect(await fileToCsv(file(new Uint8Array(MAX_FILE_BYTES + 1), 'big.csv'))).toEqual({
      ok: false,
      code: 'TOO_BIG',
    });
  });

  it('refuses a zip that is not a workbook, and a part that would expand into a bomb', async () => {
    const notBook = zipSync({ 'hello.txt': new TextEncoder().encode('hi') });
    expect(await fileToCsv(file(notBook, 'x.xlsx'))).toEqual({ ok: false, code: 'UNREADABLE' });

    const bomb = zipSync({ 'xl/workbook.xml': new Uint8Array(25 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(MAX_FILE_BYTES); // small on disk, large when opened
    expect(await fileToCsv(file(bomb, 'bomb.xlsx'))).toEqual({ ok: false, code: 'UNREADABLE' });
  });

  it('refuses a sheet with an absurd number of rows without building it in memory', async () => {
    const data = await workbook((wb) => {
      const ws = wb.addWorksheet('S');
      ws.addRow(['student_id', 'full_name']);
      ws.getCell('A900000').value = 'far away';
    });
    expect(await fileToCsv(file(data, 'huge.xlsx'))).toEqual({ ok: false, code: 'TOO_MANY_ROWS' });
  });
});
