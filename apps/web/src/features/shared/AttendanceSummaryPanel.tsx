import type { AttendanceSummary } from '../../api/lecturer';
import { formatShortDate, plural } from '../../components/format';
import { Notice, ProgressBar, Stat, StatGrid } from '../../components/ui';
import { PERCENT_REASON_HELP } from '../lecturer/labels';

/**
 * One student's attendance in one course, in numbers. Shared by the student's own course page and the
 * lecturer's page about that student, so the two always say the same thing.
 *
 * The percentage is CONFIRMED attendance over sessions that count (closed, and after ScanIn knew the
 * student belonged). When it cannot be given, the reason is shown instead of a misleading 0%.
 */
export function AttendanceSummaryPanel({
  summary,
  countedFrom,
  audience,
}: {
  summary: AttendanceSummary;
  countedFrom: string | null;
  audience: 'student' | 'lecturer';
}) {
  const { tally, eligibleSessions, inProgress, notCounted, percent, percentReason } = summary;
  const waiting = tally.provisional + tally.awaitingConfirmation;
  const who = audience === 'student' ? 'you' : 'the student';
  const reasonText =
    percentReason === 'OK'
      ? ''
      : audience === 'student'
        ? PERCENT_REASON_HELP[percentReason]
        : percentReason === 'NOT_CONFIRMED'
          ? 'This student is not confirmed against the class list yet, so no confirmed percentage is given. Confirm them under Review to enable it.'
          : percentReason === 'NOT_MATCHED'
            ? 'This student’s match to the class list was rejected, so no percentage is given.'
            : PERCENT_REASON_HELP.NO_ELIGIBLE_SESSIONS;

  return (
    <div className="stack">
      {percent !== null ? (
        <div className="stack stack--tight">
          <ProgressBar value={percent} label="Confirmed attendance" />
          <p className="muted">
            Confirmed attendance: {tally.confirmed} of {plural(eligibleSessions, 'counted session')}
            .
          </p>
        </div>
      ) : (
        <Notice tone="info" title="No confirmed percentage to show">
          {reasonText}
        </Notice>
      )}

      <StatGrid label="Attendance in this course">
        <Stat label="Sessions counted" value={eligibleSessions} />
        <Stat label="Confirmed present" value={tally.confirmed} />
        <Stat
          label="Awaiting confirmation"
          value={waiting}
          hint={waiting > 0 ? 'Recorded, not yet confirmed' : undefined}
        />
        <Stat label="Invalidated" value={tally.invalidated} />
        <Stat label="No record" value={tally.noRecord} />
      </StatGrid>

      {(inProgress > 0 || notCounted > 0) && (
        <ul className="subtle stack stack--tight" style={{ paddingLeft: '1.25rem' }}>
          {inProgress > 0 && (
            <li>
              {plural(inProgress, 'session')} still open for check-in.{' '}
              {inProgress === 1 ? 'It counts' : 'They count'} once{' '}
              {inProgress === 1 ? 'it closes' : 'they close'}.
            </li>
          )}
          {notCounted > 0 && (
            <li>
              {plural(notCounted, 'earlier session')} {notCounted === 1 ? 'is' : 'are'} not counted,
              because{' '}
              {countedFrom
                ? `${notCounted === 1 ? 'it' : 'they'} started before ${formatShortDate(countedFrom)}, when ScanIn first knew`
                : 'ScanIn did not yet know'}{' '}
              {who} {audience === 'student' ? 'were' : 'was'} in this course.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
