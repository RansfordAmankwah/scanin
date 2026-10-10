/** Plain-language labels. Never claims more certainty than the system has. */
export function associationLabel(state: string, basis: string | null): string {
  switch (state) {
    case 'CONFIRMED':
      switch (basis) {
        case 'ROSTER_ID_MATCH':
          return 'Matched to class list by student ID';
        case 'ROSTER_EMAIL_MATCH':
          return 'Matched to class list by verified e-mail';
        case 'LECTURER_IDENTITY_CONFIRMED':
          return 'Identity confirmed by lecturer';
        case 'LECTURER_ENROLLMENT_CONFIRMED':
          return 'Enrollment confirmed by lecturer';
        default:
          return 'Confirmed';
      }
    case 'PROVISIONAL':
      return 'Provisional (self-reported)';
    case 'REVIEW_REQUIRED':
      return 'Needs review';
    case 'REJECTED':
      return 'Rejected by lecturer';
    default:
      return state;
  }
}

export const STATUS_LABEL: Record<string, string> = {
  PRESENT: '✓ Present',
  INVALIDATED: '✕ Invalidated',
  NO_RECORD: 'No record',
};

export const SOURCE_LABEL: Record<string, string> = {
  QR_SCAN: 'QR scan',
  MANUAL: 'Marked by lecturer',
};

export const SESSION_STATE_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started',
  CHECK_IN_OPEN: 'Check-in open',
  CHECK_IN_CLOSED: 'Check-in closed',
  ENDED: 'Ended',
};

export const OUTCOME_LABEL: Record<string, string> = {
  ACCEPTED: 'Recorded',
  DUPLICATE_EXISTING: 'Repeat scan',
  REJECTED_TOKEN_EXPIRED: 'Rejected: code expired',
  REJECTED_TOKEN_REVOKED: 'Rejected: code cancelled',
  REJECTED_SESSION_NOT_STARTED: 'Rejected: not started',
  REJECTED_SESSION_CLOSED: 'Rejected: check-in closed',
  REJECTED_SESSION_ENDED: 'Rejected: class ended',
};

export const FLAG_LABEL: Record<string, string> = {
  PROXY_SUSPECTED: 'Suspected proxy',
  CONFLICTING_STUDENT_ID: 'Conflicting student ID',
  AMBIGUOUS_ROSTER_MATCH: 'Ambiguous class-list match',
};

export const INVALIDATION_LABEL: Record<string, string> = {
  INCORRECT_ENTRY: 'Incorrect attendance entry',
  CONFIRMED_PROXY: 'Confirmed proxy attendance',
  DUPLICATE_OR_ERRONEOUS: 'Duplicate or erroneous record',
  IDENTITY_ENROLLMENT_MISMATCH: 'Identity/enrollment mismatch',
  OTHER: 'Other',
};
