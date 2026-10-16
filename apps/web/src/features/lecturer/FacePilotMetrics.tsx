import { faceApi } from '../../api/face';
import { Card, Loading, Stat, StatGrid } from '../../components/ui';
import { useLoad } from '../../components/useLoad';

/**
 * Pilot totals for a face-enabled course. Totals only: no names and no per-student outcomes, so it
 * answers "is the pilot working?" without exposing any individual's result.
 */
export function FacePilotMetrics({ courseId }: { courseId: string }) {
  const { state } = useLoad(() => faceApi.metrics(courseId), [courseId]);
  if (state.status !== 'ready') {
    return (
      <Card title="Face pilot">
        {state.status === 'loading' ? <Loading label="Loading pilot totals…" /> : null}
      </Card>
    );
  }
  const m = state.data;
  return (
    <Card
      title="Face pilot"
      description="Totals for this course. No names, and no individual student's result."
    >
      <StatGrid>
        <Stat label="Checks attempted" value={m.attempted} />
        <Stat label="Verified" value={m.verified} />
        <Stat label="Did not match" value={m.failed} />
        <Stat label="Not a live capture" value={m.livenessRejected} />
        <Stat label="Service unavailable" value={m.unavailable} />
        <Stat label="Exempt (checked in person)" value={m.exempt} />
        <Stat label="On the in-person list" value={m.forcedListSize} />
        <Stat
          label="Median scan→verified"
          value={m.medianScanToVerifiedSeconds === null ? '—' : `${m.medianScanToVerifiedSeconds}s`}
        />
        <Stat label="Verified but not in the room" value={m.notPresentAmongFaceVerified} />
      </StatGrid>
    </Card>
  );
}
