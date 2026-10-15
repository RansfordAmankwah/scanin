import { useMemo, useState } from 'react';
import { studentApi } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import {
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  SearchField,
  SelectField,
} from '../../components/ui';
import { useLoad } from '../../components/useLoad';
import { CourseCard } from './CourseCard';

type Filter = 'ALL' | 'REVIEW' | 'UNCONFIRMED';

/** Every course the student belongs to, searchable, so their records are always one tap from here. */
export function MyCoursesPage() {
  const { state, reload } = useLoad(() => studentApi.courses(), []);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');

  const courses = state.status === 'ready' ? state.data.courses : [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return courses.filter(
      (c) =>
        (q === '' || `${c.code} ${c.title} ${c.term.name}`.toLowerCase().includes(q)) &&
        (filter === 'ALL' ||
          (filter === 'REVIEW' && c.openReviews > 0) ||
          (filter === 'UNCONFIRMED' && c.association.state !== 'CONFIRMED')),
    );
  }, [courses, query, filter]);

  return (
    <AppShell>
      <PageHeader
        title="My courses"
        breadcrumbs={[{ label: 'Home', to: '/' }, { label: 'My courses' }]}
        meta="Your attendance is kept separately for each course."
      />

      {state.status === 'loading' && <Loading label="Loading your courses…" />}
      {(state.status === 'error' || state.status === 'not-found') && (
        <ErrorState title="Could not load your courses" onRetry={() => void reload()}>
          Check your connection and try again.
        </ErrorState>
      )}

      {state.status === 'ready' &&
        (courses.length === 0 ? (
          <EmptyState title="You are not in any course yet">
            A course appears here after your first check-in, or once your lecturer adds you to its
            class list.
          </EmptyState>
        ) : (
          <>
            {courses.length > 3 && (
              <div className="toolbar">
                <SearchField
                  label="Search courses"
                  value={query}
                  onChange={setQuery}
                  placeholder="Code, title or term"
                />
                <SelectField
                  label="Show"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as Filter)}
                >
                  <option value="ALL">All courses</option>
                  <option value="REVIEW">Records under review</option>
                  <option value="UNCONFIRMED">Not yet confirmed</option>
                </SelectField>
              </div>
            )}
            {shown.length === 0 ? (
              <EmptyState title="No courses match">
                Try a different search, or show all courses.
              </EmptyState>
            ) : (
              <div className="grid grid--cards">
                {shown.map((c) => (
                  <CourseCard key={c.id} course={c} headingLevel={2} />
                ))}
              </div>
            )}
          </>
        ))}
    </AppShell>
  );
}
