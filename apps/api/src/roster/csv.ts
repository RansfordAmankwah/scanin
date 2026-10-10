import { parse } from 'csv-parse/sync';
import { normalizeEmail, normalizeFullName, normalizeStudentId } from '../auth/identifiers.js';

export const MAX_ROSTER_ROWS = 5000;
export const MAX_ROSTER_CHARS = 1_000_000;

export interface RosterRow {
  /** 1-based line number in the file (header = line 1), for error messages. */
  line: number;
  studentId: string;
  fullName: string;
  email: string | null;
}

export interface RowError {
  line: number;
  code:
    | 'INVALID_STUDENT_ID'
    | 'INVALID_NAME'
    | 'INVALID_EMAIL'
    | 'DUPLICATE_STUDENT_ID'
    | 'DUPLICATE_EMAIL';
}

export type ParsedRoster =
  | { ok: true; rows: RosterRow[]; hasEmailColumn: boolean }
  | {
      ok: false;
      code: 'UNREADABLE' | 'MISSING_COLUMNS' | 'TOO_LARGE' | 'EMPTY';
      errors: RowError[];
    }
  | { ok: false; code: 'INVALID_ROWS'; errors: RowError[] };

const HEADER_ALIASES: Record<'studentId' | 'fullName' | 'email', string[]> = {
  studentId: ['student_id', 'studentid', 'student id', 'id'],
  fullName: ['full_name', 'fullname', 'full name', 'name'],
  email: ['email', 'school_email', 'school email', 'e-mail'],
};

function findColumn(header: string[], key: keyof typeof HEADER_ALIASES): number {
  return header.findIndex((h) => HEADER_ALIASES[key].includes(h.trim().toLowerCase()));
}

/** Excel's "CSV UTF-8" output starts with a byte-order mark. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Parses and validates a roster CSV. Requires student ID and full name columns; e-mail is
 * optional. Nothing is guessed: any bad row makes the whole file invalid, with line numbers.
 */
export function parseRosterCsv(text: string): ParsedRoster {
  if (text.length > MAX_ROSTER_CHARS) return { ok: false, code: 'TOO_LARGE', errors: [] };

  let records: string[][];
  try {
    records = parse(stripBom(text), {
      skip_empty_lines: true,
      relax_column_count: false,
      trim: true,
    }) as string[][];
  } catch {
    return { ok: false, code: 'UNREADABLE', errors: [] };
  }

  const [header, ...body] = records;
  if (!header) return { ok: false, code: 'EMPTY', errors: [] };
  const idCol = findColumn(header, 'studentId');
  const nameCol = findColumn(header, 'fullName');
  const emailCol = findColumn(header, 'email');
  if (idCol < 0 || nameCol < 0) return { ok: false, code: 'MISSING_COLUMNS', errors: [] };
  if (body.length === 0) return { ok: false, code: 'EMPTY', errors: [] };
  if (body.length > MAX_ROSTER_ROWS) return { ok: false, code: 'TOO_LARGE', errors: [] };

  const rows: RosterRow[] = [];
  const errors: RowError[] = [];
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();

  body.forEach((cells, index) => {
    const line = index + 2;
    const studentId = normalizeStudentId(cells[idCol] ?? '');
    const fullName = normalizeFullName(cells[nameCol] ?? '');
    const rawEmail = emailCol >= 0 ? (cells[emailCol] ?? '') : '';
    const email = rawEmail ? normalizeEmail(rawEmail) : null;

    if (!studentId) return void errors.push({ line, code: 'INVALID_STUDENT_ID' });
    if (!fullName) return void errors.push({ line, code: 'INVALID_NAME' });
    if (email && !EMAIL.test(email)) return void errors.push({ line, code: 'INVALID_EMAIL' });
    if (seenIds.has(studentId)) return void errors.push({ line, code: 'DUPLICATE_STUDENT_ID' });
    if (email && seenEmails.has(email)) return void errors.push({ line, code: 'DUPLICATE_EMAIL' });

    seenIds.add(studentId);
    if (email) seenEmails.add(email);
    rows.push({ line, studentId, fullName, email });
  });

  if (errors.length > 0) return { ok: false, code: 'INVALID_ROWS', errors };
  return { ok: true, rows, hasEmailColumn: emailCol >= 0 };
}
