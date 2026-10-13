import { expectGoodScreen } from '../support/checks';
import { expect, lecturerSignIn, test } from '../support/fixtures';
import { xlsxBytes } from '../support/xlsx';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test.describe('importing a class list from a spreadsheet', () => {
  test.beforeEach(async ({ page }) => {
    await lecturerSignIn(page);
    await page.getByRole('link', { name: /E2E101/ }).click();
    await expect(page.getByLabel('Spreadsheet or CSV file')).toBeVisible();
  });

  test('an Excel workbook is read, shown as text, previewed and applied through the real server', async ({
    page,
  }) => {
    const data = xlsxBytes([
      ['Student ID', 'Full Name', 'E-mail'], // the headers people really use
      ['XLS001', 'Ama Boateng', 'ama.boateng@e2e.test'],
      [220033, 'Kwame "KK" Mensah'], // a numeric ID, and no e-mail cell at all
      [],
      ['XLS003', 'Zoë Müller, Jr.', 'zoe@e2e.test'],
    ]);
    await page
      .getByLabel('Spreadsheet or CSV file')
      .setInputFiles({ name: 'class list.xlsx', mimeType: XLSX, buffer: data });

    await expect(
      page.getByText(/class list\.xlsx: Read 4 rows from sheet "Class list"/),
    ).toBeVisible();
    const box = page.getByLabel('Or paste the CSV');
    await expect(box).toHaveValue(/XLS001,Ama Boateng,ama\.boateng@e2e\.test/);
    await expect(box).toHaveValue(/220033,"Kwame ""KK"" Mensah",/);
    await expect(box).toHaveValue(/"Zoë Müller, Jr\."/);

    await page.getByRole('button', { name: 'Preview changes' }).click();
    await expect(page.getByText(/3 to add/)).toBeVisible();
    await expectGoodScreen(page, 'spreadsheet import preview');
    await page.getByRole('button', { name: 'Apply changes' }).click();
    await expect(page.getByText(/Class list updated: 3 added/)).toBeVisible();
  });

  test('cells copied from Excel or Google Sheets (tab-separated) work when pasted', async ({
    page,
  }) => {
    await page
      .getByLabel('Or paste the CSV')
      .fill(
        'student_id\tfull_name\temail\nPASTE01\tPaste One\tp1@e2e.test\nPASTE02\tPaste Two\t\n',
      );
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await expect(page.getByText(/2 to add/)).toBeVisible();
    await expect(page.getByLabel('Or paste the CSV')).toHaveValue(
      /student_id,full_name,email\nPASTE01,Paste One,p1@e2e\.test/,
    );
  });

  test('a semicolon CSV saved by Excel in Windows-1252 keeps its accents', async ({ page }) => {
    const latin1 = Buffer.concat([
      Buffer.from('student_id;full_name\nSEMI01;Ren'),
      Buffer.from([0xe9]), // é in Windows-1252, invalid UTF-8
      Buffer.from(' Dupont\n'),
    ]);
    await page
      .getByLabel('Spreadsheet or CSV file')
      .setInputFiles({ name: 'latin.csv', mimeType: 'text/csv', buffer: latin1 });
    await expect(page.getByLabel('Or paste the CSV')).toHaveValue(/SEMI01,René Dupont/);
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await expect(page.getByText(/1 to add/)).toBeVisible();
  });

  test('files it cannot read get a plain explanation and nothing is imported', async ({ page }) => {
    await page.getByLabel('Spreadsheet or CSV file').setInputFiles({
      name: 'old.xls',
      mimeType: 'application/vnd.ms-excel',
      buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    });
    await expect(page.getByText(/old Excel file \(\.xls\)/)).toBeVisible();
    await expect(page.getByLabel('Or paste the CSV')).toHaveValue('');

    await page.getByLabel('Spreadsheet or CSV file').setInputFiles({
      name: 'list.ods',
      mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
      buffer: Buffer.from('PK'),
    });
    await expect(page.getByText(/cannot be read.*Excel \(\.xlsx\) or CSV/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
  });
});
