/**
 * Spreadsheet formula injection defence. A text cell that begins with =, +, -, @, tab or carriage
 * return can be run as a formula when opened in Excel or Sheets. Names are free text chosen by
 * students, so every text cell is treated as untrusted. A leading apostrophe makes the cell inert
 * (spreadsheets show the text without the apostrophe).
 */
const DANGEROUS_START = /^[\s]*[=+\-@\t\r]/;

export function safeCell(value: string): string {
  return DANGEROUS_START.test(value) ? `'${value}` : value;
}

export const safeRow = (row: string[]): string[] => row.map(safeCell);
