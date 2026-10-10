/** Roles the system recognises. Exactly two. */
export const ROLES = ['LECTURER', 'STUDENT'] as const;
export type Role = (typeof ROLES)[number];

/** Class-session lifecycle states (transition rules arrive with the session milestone). */
export const SESSION_STATES = ['NOT_STARTED', 'CHECK_IN_OPEN', 'CHECK_IN_CLOSED', 'ENDED'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Attendance status. Independent of identity review and investigation flags. */
export const ATTENDANCE_STATUSES = ['PRESENT', 'INVALIDATED'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
