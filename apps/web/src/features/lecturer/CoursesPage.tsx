import { useEffect, useState } from 'react';
import { lecturerApi, type Course } from '../../api/lecturer';
import { Notice } from '../../components/ui';
import { CreateCourse } from './CreateCourse';
import { Link } from '../../router';

export function CoursesPage() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void lecturerApi.courses().then((r) => {
      if (cancelled) return;
      if (r.ok) setCourses(r.data.courses);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <Notice tone="danger" title="Could not load your courses" urgent>
        Refresh the page to try again.
      </Notice>
    );
  }
  if (!courses) return <p role="status">Loading your courses…</p>;
  const created = (course: Course) => setCourses((list) => [course, ...(list ?? [])]);
  return (
    <div className="stack">
      {courses.length === 0 ? (
        <Notice tone="info" title="No courses yet">
          Create your first course below. You will see only the courses you create or are assigned
          to.
        </Notice>
      ) : (
        <section aria-labelledby="courses-heading">
          <h2 id="courses-heading">Your courses</h2>
          <ul className="list">
            {courses.map((c) => (
              <li key={c.id} className="card">
                <Link to={`/courses/${c.id}`}>
                  <strong>{c.code}</strong> {c.title}
                </Link>
                <span className="muted">{c.term.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <CreateCourse onCreated={created} />
    </div>
  );
}
