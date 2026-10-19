import { useState } from 'react';
import { courseApi, lecturerApi } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import { plural } from '../../components/format';
import {
  Badge,
  ErrorState,
  Loading,
  LinkButton,
  Notice,
  PageHeader,
  Tabs,
  type TabItem,
} from '../../components/ui';
import { useLoad } from '../../components/useLoad';
import { AttendanceTab } from './AttendanceTab';
import { ClassListTab } from './ClassListTab';
import { FacePilotMetrics } from './FacePilotMetrics';
import { ReviewQueue } from './ReviewQueue';
import { SessionsTab } from './SessionsTab';
import { HOME_PATH } from '../../router';

export type CourseTab = 'sessions' | 'attendance' | 'class-list' | 'review';

/**
 * Everything about one course, in four parts: its sessions, its attendance (by session and by
 * student), its class list, and what needs review. Each part is its own address.
 */
export function CourseWorkspace({ courseId, tab }: { courseId: string; tab: CourseTab }) {
  const course = useLoad(() => lecturerApi.course(courseId), [courseId]);
  const overview = useLoad(() => courseApi.overview(), [courseId]);
  const summary = useLoad(() => courseApi.summary(courseId), [courseId]);
  const [reviewKey, setReviewKey] = useState(0);

  const c = course.state;
  if (c.status === 'not-found') {
    return (
      <AppShell>
        <PageHeader title="Course not found" breadcrumbs={[{ label: 'Courses', to: HOME_PATH }]} />
        <Notice tone="danger" title="Course not found" urgent>
          It may not exist, or you may not be assigned to it.
        </Notice>
      </AppShell>
    );
  }
  if (c.status !== 'ready') {
    return (
      <AppShell>
        <PageHeader title="Course" breadcrumbs={[{ label: 'Courses', to: HOME_PATH }]} />
        {c.status === 'loading' ? (
          <Loading label="Loading the course…" />
        ) : (
          <ErrorState title="Could not load this course" onRetry={() => void course.reload()}>
            Refresh the page to try again.
          </ErrorState>
        )}
      </AppShell>
    );
  }

  const info = c.data.course;
  const mine =
    overview.state.status === 'ready'
      ? overview.state.data.courses.find((x) => x.id === courseId)
      : undefined;
  const needs = mine ? mine.attention.matchesToReview + mine.attention.openFlags : 0;
  const base = `/courses/${courseId}`;
  const current = {
    sessions: base,
    attendance: `${base}/attendance`,
    'class-list': `${base}/class-list`,
    review: `${base}/review`,
  }[tab];
  const tabs: TabItem[] = [
    { to: base, label: 'Sessions' },
    { to: `${base}/attendance`, label: 'Attendance', count: mine?.attention.openReviews ?? 0 },
    { to: `${base}/class-list`, label: 'Class list' },
    { to: `${base}/review`, label: 'Review', count: needs },
  ];

  return (
    <AppShell>
      <PageHeader
        title={`${info.code} ${info.title}`}
        breadcrumbs={[{ label: 'Courses', to: HOME_PATH }, { label: info.code }]}
        meta={
          <>
            <span>{info.term.name}</span>
            {mine && <span>{plural(mine.students.registered, 'student')}</span>}
            {mine?.openSession && <Badge tone="info">Check-in open</Badge>}
          </>
        }
        actions={
          mine?.openSession ? (
            <LinkButton to={`${base}/sessions/${mine.openSession.id}`}>
              Open live session
            </LinkButton>
          ) : undefined
        }
      />

      <Tabs label="Course sections" items={tabs} current={current} />

      {info.faceVerificationEnabled && <FacePilotMetrics courseId={courseId} />}

      {tab === 'sessions' && (
        <SessionsTab
          courseId={courseId}
          summary={summary.state}
          onCreated={() => {
            void summary.reload();
            void overview.reload();
          }}
        />
      )}
      {tab === 'attendance' && (
        <AttendanceTab
          courseId={courseId}
          summary={summary.state}
          onRetry={() => void summary.reload()}
        />
      )}
      {tab === 'class-list' && (
        <ClassListTab
          courseId={courseId}
          onApplied={() => {
            void summary.reload();
            void overview.reload();
            setReviewKey((k) => k + 1);
          }}
        />
      )}
      {tab === 'review' && <ReviewQueue courseId={courseId} key={reviewKey} />}
    </AppShell>
  );
}
