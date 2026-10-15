import type { LinkState, Outcome, PercentReason } from '../../api/lecturer';
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

// --- Course-based attendance ----------------------------------------------------------------------

export const ATTENDANCE_OUTCOME_LABEL: Record<Outcome, string> = {
  CONFIRMED: 'Present',
  PROVISIONAL: 'Recorded, not yet confirmed',
  AWAITING_CONFIRMATION: 'Recorded, awaiting review',
  INVALIDATED: 'Invalidated',
  NO_RECORD: 'No record',
  IN_PROGRESS: 'In progress',
  NOT_COUNTED: 'Not counted',
};

export const ATTENDANCE_OUTCOME_TONE: Record<Outcome, BadgeTone> = {
  CONFIRMED: 'success',
  PROVISIONAL: 'warning',
  AWAITING_CONFIRMATION: 'attention',
  INVALIDATED: 'danger',
  NO_RECORD: 'neutral',
  IN_PROGRESS: 'info',
  NOT_COUNTED: 'neutral',
};

/** What each outcome means, in a student's words. Never mentions flags or how a record was found. */
export const ATTENDANCE_OUTCOME_HELP: Record<Outcome, string> = {
  CONFIRMED: 'Confirmed against the class list, or by your lecturer.',
  PROVISIONAL:
    'Your check-in is recorded. It counts as confirmed once your lecturer matches you to the class list.',
  AWAITING_CONFIRMATION:
    'Your check-in is recorded. Your lecturer is still deciding whether you match the class list.',
  INVALIDATED: 'Your lecturer invalidated this record.',
  NO_RECORD: 'You did not check in to this session.',
  IN_PROGRESS:
    'Check-in for this session is still open. It counts toward your attendance once it closes.',
  NOT_COUNTED:
    'This session started before ScanIn knew you were in this course, so it is not counted for or against you.',
};

/** The same outcomes, described for the lecturer. */
export const ATTENDANCE_OUTCOME_HELP_LECTURER: Record<Outcome, string> = {
  CONFIRMED: 'Present, and the student is confirmed against the class list.',
  PROVISIONAL: 'Present, but the student is not yet confirmed against the class list.',
  AWAITING_CONFIRMATION: 'Present, but the match to the class list is still under review.',
  INVALIDATED: 'Invalidated by a lecturer.',
  NO_RECORD: 'No check-in was recorded for this session. That is not a finding about the student.',
  IN_PROGRESS: 'Check-in for this session is still open.',
  NOT_COUNTED:
    'Not counted: the session started before ScanIn knew the student belonged to this course.',
};

export const PERCENT_REASON_HELP: Record<Exclude<PercentReason, 'OK'>, string> = {
  NO_ELIGIBLE_SESSIONS: 'No session has closed yet, so there is nothing to calculate.',
  NOT_CONFIRMED:
    'Your lecturer has not yet confirmed you against the class list, so a confirmed percentage is not available yet.',
  NOT_MATCHED: 'Your lecturer has not matched you to this course’s class list.',
};

export const LINK_STATE_LABEL: Record<LinkState, string> = {
  PROVISIONAL: 'Not yet confirmed',
  REVIEW_REQUIRED: 'Under review',
  CONFIRMED: 'Confirmed',
  REJECTED: 'Not matched',
};

export const LINK_STATE_TONE: Record<LinkState, BadgeTone> = {
  PROVISIONAL: 'warning',
  REVIEW_REQUIRED: 'attention',
  CONFIRMED: 'success',
  REJECTED: 'danger',
};
