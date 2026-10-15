import { useState } from 'react';
import { studentApi } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import { EmptyState, ErrorState, Loading, PageHeader } from '../../components/ui';
import { useLoad } from '../../components/useLoad';
import { Link } from '../../router';
import { useAuth } from '../auth/AuthGate';
import { CheckInScreen } from './CheckInScreen';
import { CourseCard } from './CourseCard';

const SHOWN = 3;

/** The student's front door: check in first, then where they stand in each course. */
export function StudentHome() {
  const { user } = useAuth();
  const [reloadKey, setReloadKey] = useState(0);
  const { state, reload } = useLoad(() => studentApi.courses(), [reloadKey]);
  const first = user.fullName.split(' ')[0];

  return (
    <AppShell width="medium">
      <PageHeader
        title={`Hello, ${first}`}
        meta="Check in to class, or see how your attendance stands."
      />

      <CheckInScreen onFinished={() => setReloadKey((k) => k + 1)} />

      <section className="stack" aria-labelledby="home-courses-heading">
        <div className="section-title">
          <h2 id="home-courses-heading">Your courses</h2>
          {state.status === 'ready' && state.data.courses.length > SHOWN && (
            <Link to="/my/courses">See all {state.data.courses.length} courses</Link>
          )}
        </div>

        {state.status === 'loading' && <Loading label="Loading your courses…" />}
        {(state.status === 'error' || state.status === 'not-found') && (
          <ErrorState title="Could not load your courses" onRetry={() => void reload()}>
            Check your connection and try again.
          </ErrorState>
        )}
        {state.status === 'ready' &&
          (state.data.courses.length === 0 ? (
            <EmptyState title="No courses yet">
              Your courses appear here after your first check-in. Scan the QR code your lecturer
              shows in class.
            </EmptyState>
          ) : (
            <div className="grid grid--cards">
              {state.data.courses.slice(0, SHOWN).map((c) => (
                <CourseCard key={c.id} course={c} />
              ))}
            </div>
          ))}
      </section>
    </AppShell>
  );
}
