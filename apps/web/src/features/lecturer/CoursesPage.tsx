import { courseApi, type LecturerCourseOverview } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import { plural } from '../../components/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LinkButton,
  Loading,
  PageHeader,
} from '../../components/ui';
import { useLoad } from '../../components/useLoad';
import { Link } from '../../router';
import { CreateCourse } from './CreateCourse';

interface AttentionItem {
  key: string;
  to: string;
  title: string;
  detail: string;
}

/** What needs the lecturer now, across every course: live sessions first, then unresolved records. */
function attentionItems(courses: LecturerCourseOverview[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const c of courses) {
    if (c.openSession) {
      items.push({
        key: `open-${c.id}`,
        to: `/courses/${c.id}/sessions/${c.openSession.id}`,
        title: `Check-in is open in ${c.code}`,
        detail: `${c.openSession.title}: ${plural(c.openSession.present, 'student')} recorded so far`,
      });
    }
    if (c.attention.matchesToReview > 0) {
      items.push({
        key: `match-${c.id}`,
        to: `/courses/${c.id}/review`,
        title: `${plural(c.attention.matchesToReview, 'student')} to match in ${c.code}`,
        detail: 'Their class-list match needs your decision.',
      });
    }
    if (c.attention.openReviews > 0) {
      items.push({
        key: `review-${c.id}`,
        to: `/courses/${c.id}/attendance`,
        title: `${plural(c.attention.openReviews, 'record')} under review in ${c.code}`,
        detail: 'A spot check could not find the student. Decide whether the record stands.',
      });
    }
    if (c.attention.openFlags > 0) {
      items.push({
        key: `flags-${c.id}`,
        to: `/courses/${c.id}/review`,
        title: `${plural(c.attention.openFlags, 'flag')} open in ${c.code}`,
        detail: 'Flagged records are waiting for a decision.',
      });
    }
  }
  return items;
}

function CourseCard({ course }: { course: LecturerCourseOverview }) {
  const { attention, openSession, lastSession, students } = course;
  const href = `/courses/${course.id}`;
  return (
    <article className="course-card" aria-label={`${course.code} ${course.title}`}>
      <div>
        <div className="course-card__code">
          {course.code} · {course.term.name}
        </div>
        <h2 className="course-card__title">
          <Link to={href}>
            <strong>{course.code}</strong> {course.title}
          </Link>
        </h2>
      </div>

      <div className="course-card__facts">
        {openSession ? (
          <p className="cluster">
            <Badge tone="info">Check-in open</Badge>
            <span>
              {openSession.title}: {plural(openSession.present, 'student')} recorded
            </span>
          </p>
        ) : lastSession ? (
          <p>
            Last session: {lastSession.title} · {plural(lastSession.present, 'student')} present
          </p>
        ) : (
          <p>No session has started yet.</p>
        )}
        <p>
          {plural(students.registered, 'student')} with an account
          {students.notRegistered > 0
            ? ` · ${students.notRegistered} on the class list without one`
            : ''}
        </p>
        {(attention.matchesToReview > 0 ||
          attention.openReviews > 0 ||
          attention.openFlags > 0) && (
          <div className="cluster">
            {attention.matchesToReview > 0 && (
              <Badge tone="attention">{attention.matchesToReview} to match</Badge>
            )}
            {attention.openReviews > 0 && (
              <Badge tone="attention">{attention.openReviews} under review</Badge>
            )}
            {attention.openFlags > 0 && (
              <Badge tone="attention">{attention.openFlags} flagged</Badge>
            )}
          </div>
        )}
      </div>

      <div className="course-card__footer">
        {openSession && (
          <LinkButton to={`/courses/${course.id}/sessions/${openSession.id}`} size="sm">
            Open live session
          </LinkButton>
        )}
        <LinkButton to={href} variant="secondary" size="sm">
          Open course
        </LinkButton>
      </div>
    </article>
  );
}

/** The lecturer's home: what needs attention, then every course at a glance. */
export function CoursesPage() {
  const { state, reload } = useLoad(() => courseApi.overview(), []);
  const courses = state.status === 'ready' ? state.data.courses : [];
  const attention = attentionItems(courses);

  return (
    <AppShell>
      <PageHeader
        title="Your courses"
        meta="Open a course to run a session, review attendance, or manage its class list."
      />

      {state.status === 'loading' && <Loading label="Loading your courses…" />}
      {(state.status === 'error' || state.status === 'not-found') && (
        <ErrorState title="Could not load your courses" onRetry={() => void reload()}>
          Refresh the page to try again.
        </ErrorState>
      )}

      {state.status === 'ready' && (
        <>
          {attention.length > 0 && (
            <Card
              flush
              title="Needs your attention"
              description="The most time-sensitive things first."
            >
              <ul className="rowlist">
                {attention.map((a) => (
                  <li key={a.key}>
                    <Link to={a.to} className="row">
                      <span className="row__main">
                        <span className="row__title">{a.title}</span>
                        <span className="row__meta">{a.detail}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {courses.length === 0 ? (
            <EmptyState title="No courses yet">
              Create your first course below. You will see only the courses you create or are
              assigned to.
            </EmptyState>
          ) : (
            <div className="grid grid--cards">
              {courses.map((c) => (
                <CourseCard key={c.id} course={c} />
              ))}
            </div>
          )}
        </>
      )}

      <CreateCourse onCreated={() => void reload()} />
    </AppShell>
  );
}
