import type { BadgeTone } from '../../components/ui';

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
  REJECTED_DEVICE_REUSED: 'Rejected: device already used',
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

export const STATUS_TONE: Record<string, BadgeTone> = {
  PRESENT: 'success',
  INVALIDATED: 'danger',
  NO_RECORD: 'neutral',
};

export function associationTone(state: string): BadgeTone {
  switch (state) {
    case 'CONFIRMED':
      return 'success';
    case 'PROVISIONAL':
      return 'warning';
    case 'REVIEW_REQUIRED':
      return 'attention';
    case 'REJECTED':
      return 'danger';
    default:
      return 'neutral';
  }
}

// --- Anti-proxy controls ------------------------------------------------------------------------

export const RECONCILIATION_LABEL: Record<string, string> = {
  NO_HEADCOUNT: 'No headcount yet',
  CONSISTENT: 'Counts agree',
  REVIEW_RECOMMENDED: 'Review recommended',
  MORE_PEOPLE_THAN_RECORDS: 'More people than records',
};

export const RECONCILIATION_TONE: Record<string, BadgeTone> = {
  NO_HEADCOUNT: 'neutral',
  CONSISTENT: 'success',
  REVIEW_RECOMMENDED: 'attention',
  MORE_PEOPLE_THAN_RECORDS: 'info',
};

export const RISK_FACTOR_LABEL: Record<string, string> = {
  DEVICE_SHARED_FLAG: 'several students checked in from the same device in this class',
  PRIOR_NOT_PRESENT_RESULT: 'an earlier spot check in this course could not find them',
};

export const SPOT_STATE_LABEL: Record<string, string> = {
  PENDING: 'Not checked yet',
  VERIFIED: 'Verified in person',
  NOT_PRESENT: 'Not found in the room',
  COULD_NOT_VERIFY: 'Could not verify',
};

export const SPOT_STATE_TONE: Record<string, BadgeTone> = {
  PENDING: 'neutral',
  VERIFIED: 'success',
  NOT_PRESENT: 'attention',
  COULD_NOT_VERIFY: 'warning',
};

export const METHOD_LABEL: Record<string, string> = {
  STUDENT_ID_CARD: 'Student ID card',
  ROSTER_PHOTO: 'Roster photo',
  OTHER_OFFICIAL_ID: 'Other official ID',
};

export const DISPUTE_LABEL: Record<string, string> = {
  OPEN: 'Under review',
  RESOLVED_UPHELD: 'Review closed: record stands',
  RESOLVED_INVALIDATED: 'Review closed: record invalidated',
};

export const DISPUTE_TONE: Record<string, BadgeTone> = {
  OPEN: 'attention',
  RESOLVED_UPHELD: 'success',
  RESOLVED_INVALIDATED: 'danger',
};
