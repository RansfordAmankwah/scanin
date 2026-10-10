import { describe, expect, it } from 'vitest';
import { ATTENDANCE_STATUSES, ROLES, SESSION_STATES } from '../src/index.js';

describe('shared enums', () => {
  it('defines exactly two roles', () => {
    expect(ROLES).toEqual(['LECTURER', 'STUDENT']);
  });

  it('defines the four agreed session states', () => {
    expect(SESSION_STATES).toEqual(['NOT_STARTED', 'CHECK_IN_OPEN', 'CHECK_IN_CLOSED', 'ENDED']);
  });

  it('defines only PRESENT and INVALIDATED attendance statuses (no late status)', () => {
    expect(ATTENDANCE_STATUSES).toEqual(['PRESENT', 'INVALIDATED']);
  });
});
