import { useState } from 'react';
import { faceApi, type IdMethod } from '../../api/face';
import { courseApi, lecturerApi } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  LinkButton,
  Loading,
  Notice,
  PageHeader,
  SelectField,
} from '../../components/ui';
import { useLoad } from '../../components/useLoad';
import { AttendanceSummaryPanel } from '../shared/AttendanceSummaryPanel';
import { SessionHistoryList } from '../shared/SessionHistoryList';
import { LINK_STATE_LABEL, LINK_STATE_TONE } from './labels';
import { HOME_PATH } from '../../router';

/** Face-verification pilot: a lecturer opens a supervised enrollment after checking the student's ID. */
function FaceEnrollment({
  courseId,
  linkId,
  name,
}: {
  courseId: string;
  linkId: string;
  name: string;
}) {
  const [idMethod, setIdMethod] = useState<IdMethod>('STUDENT_ID_CARD');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await faceApi.openEnrollment(courseId, linkId, idMethod);
    setBusy(false);
    if (r.ok) {
      setMessage({
        tone: 'success',
        text: `Enrollment started. Ask ${name} to open their Privacy page on their own device to finish within the next few minutes.`,
      });
    } else {
      setMessage({
        tone: 'danger',
        text:
          r.code === 'ALREADY_ENROLLED'
            ? 'This student already has a face enrollment.'
            : 'Could not start enrollment. Try again.',
      });
    }
  };

  return (
    <Card
      title="Face enrollment"
      description="Check this student's photo ID in person, then start their enrollment. They complete the capture on their own device."
    >
      <div className="form-grid form-grid--2">
        <SelectField
          label="How did you check their ID?"
          value={idMethod}
          onChange={(e) => setIdMethod(e.target.value as IdMethod)}
        >
          <option value="STUDENT_ID_CARD">Student ID card</option>
          <option value="OTHER_OFFICIAL_ID">Other official ID</option>
        </SelectField>
      </div>
      {message && (
        <Notice tone={message.tone} title={message.text} urgent={message.tone === 'danger'} />
      )}
      <div className="actions">
        <Button onClick={() => void start()} disabled={busy}>
          {busy ? 'Starting…' : 'Start face enrollment'}
        </Button>
      </div>
    </Card>
  );
}

/** One student's attendance across a course, for the lecturer: cumulative, then session by session. */
export function StudentHistoryPage({ courseId, linkId }: { courseId: string; linkId: string }) {
  const history = useLoad(() => courseApi.student(courseId, linkId), [courseId, linkId]);
  const course = useLoad(() => lecturerApi.course(courseId), [courseId]);
  const code = course.state.status === 'ready' ? course.state.data.course.code : 'Course';

  const crumbs = [
    { label: 'Courses', to: HOME_PATH },
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
  const faceEnabled =
    course.state.status === 'ready' && course.state.data.course.faceVerificationEnabled === true;
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

      {faceEnabled && (
        <FaceEnrollment courseId={courseId} linkId={linkId} name={student.fullName} />
      )}

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
