import { courseApi, lecturerApi } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import {
  Badge,
  Card,
  ErrorState,
  LinkButton,
  Loading,
  Notice,
  PageHeader,
} from '../../components/ui';
import { useLoad } from '../../components/useLoad';
import { AttendanceSummaryPanel } from '../shared/AttendanceSummaryPanel';
import { SessionHistoryList } from '../shared/SessionHistoryList';
import { LINK_STATE_LABEL, LINK_STATE_TONE } from './labels';

/** One student's attendance across a course, for the lecturer: cumulative, then session by session. */
export function StudentHistoryPage({ courseId, linkId }: { courseId: string; linkId: string }) {
  const history = useLoad(() => courseApi.student(courseId, linkId), [courseId, linkId]);
  const course = useLoad(() => lecturerApi.course(courseId), [courseId]);
  const code = course.state.status === 'ready' ? course.state.data.course.code : 'Course';

  const crumbs = [
    { label: 'Courses', to: '/' },
    { label: code, to: `/courses/${courseId}` },
    { label: 'Attendance', to: `/courses/${courseId}/attendance` },
  ];

  if (history.state.status === 'not-found') {
    return (
      <AppShell>
        <PageHeader title="Student not found" breadcrumbs={crumbs} />
        <Notice tone="danger" title="We could not find that student in this course" urgent>
          They may not belong to this course, or you may not be assigned to it.
        </Notice>
        <div className="actions">
          <LinkButton to={`/courses/${courseId}/attendance`} variant="secondary">
            Back to attendance
          </LinkButton>
        </div>
      </AppShell>
    );
  }
  if (history.state.status !== 'ready') {
    return (
      <AppShell>
        <PageHeader title="Student" breadcrumbs={crumbs} />
        {history.state.status === 'loading' ? (
          <Loading label="Loading attendance…" />
        ) : (
          <ErrorState title="Could not load this student" onRetry={() => void history.reload()}>
            Check your connection and try again.
          </ErrorState>
        )}
      </AppShell>
    );
  }

  const { student, summary, countedFrom, sessions } = history.state.data;
  return (
    <AppShell>
      <PageHeader
        title={student.fullName}
        breadcrumbs={[...crumbs, { label: student.fullName }]}
        meta={
          <>
            <span>{student.studentId}</span>
            <Badge tone={LINK_STATE_TONE[student.associationState]}>
              {LINK_STATE_LABEL[student.associationState]}
            </Badge>
          </>
        }
      />

      <Card title="Attendance in this course">
        <AttendanceSummaryPanel summary={summary} countedFrom={countedFrom} audience="lecturer" />
      </Card>

      <Card
        title="Sessions"
        description="Newest first. Flags and spot checks are visible to you only."
      >
        <SessionHistoryList
          sessions={sessions}
          audience="lecturer"
          onChanged={() => void history.reload()}
        />
      </Card>
    </AppShell>
  );
}
