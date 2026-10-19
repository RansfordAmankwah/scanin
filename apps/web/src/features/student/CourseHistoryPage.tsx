import { studentApi } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import {
  Badge,
  Card,
  ErrorState,
  Loading,
  LinkButton,
  Notice,
  PageHeader,
} from '../../components/ui';
import { useLoad } from '../../components/useLoad';
import { LINK_STATE_LABEL, LINK_STATE_TONE } from '../lecturer/labels';
import { AttendanceSummaryPanel } from '../shared/AttendanceSummaryPanel';
import { SessionHistoryList } from '../shared/SessionHistoryList';
import { HOME_PATH } from '../../router';

/**
 * One course's attendance for the signed-in student. The server derives the student from the sign-in
 * and returns only this course's sessions; a course they are not part of is simply "not found".
 */
export function CourseHistoryPage({ courseId }: { courseId: string }) {
  const { state, reload } = useLoad(() => studentApi.course(courseId), [courseId]);

  if (state.status === 'not-found') {
    return (
      <AppShell width="medium">
        <PageHeader
          title="Course not found"
          breadcrumbs={[{ label: 'My courses', to: '/my/courses' }]}
        />
        <Notice tone="danger" title="We could not find that course" urgent>
          It may not exist, or you may not be part of it.
        </Notice>
        <div className="actions">
          <LinkButton to="/my/courses" variant="secondary">
            Back to my courses
          </LinkButton>
        </div>
      </AppShell>
    );
  }

  if (state.status !== 'ready') {
    return (
      <AppShell>
        <PageHeader title="Attendance" breadcrumbs={[{ label: 'My courses', to: '/my/courses' }]} />
        {state.status === 'loading' ? (
          <Loading label="Loading your attendance…" />
        ) : (
          <ErrorState title="Could not load this course" onRetry={() => void reload()}>
            Check your connection and try again.
          </ErrorState>
        )}
      </AppShell>
    );
  }

  const { course, association, summary, countedFrom, sessions } = state.data;
  return (
    <AppShell>
      <PageHeader
        title={`${course.code} ${course.title}`}
        breadcrumbs={[
          { label: 'Home', to: HOME_PATH },
          { label: 'My courses', to: '/my/courses' },
          { label: course.code },
        ]}
        meta={
          <>
            <span>{course.term.name}</span>
            <Badge tone={LINK_STATE_TONE[association.state]}>
              {LINK_STATE_LABEL[association.state]}
            </Badge>
          </>
        }
      />

      <Card title="Your attendance in this course">
        <AttendanceSummaryPanel summary={summary} countedFrom={countedFrom} audience="student" />
      </Card>

      <Card title="Sessions" description="Newest first. Open a session to see what it means.">
        <SessionHistoryList
          sessions={sessions}
          audience="student"
          onChanged={() => void reload()}
        />
      </Card>
    </AppShell>
  );
}
