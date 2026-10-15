import type { StudentCourseSummary } from '../../api/lecturer';
import { formatShortDate, plural } from '../../components/format';
import { Badge, LinkButton, ProgressBar } from '../../components/ui';
import { Link } from '../../router';
import {
  ATTENDANCE_OUTCOME_LABEL,
  ATTENDANCE_OUTCOME_TONE,
  LINK_STATE_LABEL,
  LINK_STATE_TONE,
  PERCENT_REASON_HELP,
} from '../lecturer/labels';

/** One course at a glance for the student: how they are doing, what is unresolved, and where to look. */
export function CourseCard({
  course,
  headingLevel = 3,
}: {
  course: StudentCourseSummary;
  /** 2 when the cards sit directly under the page title, 3 when under a section heading. */
  headingLevel?: 2 | 3;
}) {
  const Heading = `h${headingLevel}` as const;
  const { summary, association, latestSession } = course;
  const waiting = summary.tally.provisional + summary.tally.awaitingConfirmation;
  const href = `/my/courses/${course.id}`;
  return (
    <article className="course-card" aria-label={`${course.code} ${course.title}`}>
      <div>
        <div className="course-card__code">
          {course.code} · {course.term.name}
        </div>
        <Heading className="course-card__title">
          <Link to={href}>{course.title}</Link>
        </Heading>
      </div>

      <div className="course-card__facts">
        {summary.percent !== null ? (
          <>
            <ProgressBar value={summary.percent} label={`Confirmed attendance in ${course.code}`} />
            <p>
              {summary.tally.confirmed} confirmed of{' '}
              {plural(summary.eligibleSessions, 'counted session')}
            </p>
          </>
        ) : (
          <p>{summary.percentReason === 'OK' ? '' : PERCENT_REASON_HELP[summary.percentReason]}</p>
        )}
        <div className="cluster">
          <Badge tone={LINK_STATE_TONE[association.state]}>
            {LINK_STATE_LABEL[association.state]}
          </Badge>
          {waiting > 0 && <Badge tone="warning">{waiting} awaiting confirmation</Badge>}
          {course.openReviews > 0 && <Badge tone="attention">Under review</Badge>}
        </div>
        {latestSession && (
          <p>
            Latest: {latestSession.title}, {formatShortDate(latestSession.date)}{' '}
            <Badge tone={ATTENDANCE_OUTCOME_TONE[latestSession.outcome]}>
              {ATTENDANCE_OUTCOME_LABEL[latestSession.outcome]}
            </Badge>
          </p>
        )}
      </div>

      <div className="course-card__footer">
        <LinkButton to={href} variant="secondary" size="sm">
          View attendance
        </LinkButton>
      </div>
    </article>
  );
}
