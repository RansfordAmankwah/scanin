const STUDENT_ID_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{2,31}$/;

/**
 * Canonical form used for matching and uniqueness: Unicode-normalised, whitespace removed,
 * upper-cased. Returns null if the result is not a plausible student ID.
 */
export function normalizeStudentId(raw: string): string | null {
  const s = raw.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  return STUDENT_ID_PATTERN.test(s) ? s : null;
}

/** The ID as the student typed it, tidied for display. */
export function displayStudentId(raw: string): string {
  return raw.normalize('NFKC').trim();
}

export function normalizeFullName(raw: string): string | null {
  const s = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return s.length >= 2 && s.length <= 100 ? s : null;
}

export function normalizeEmail(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}
