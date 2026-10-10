import { useEffect, useState } from 'react';
import { lecturerApi, type Course } from '../../api/lecturer';
import { Notice } from '../../components/ui';
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
  if (courses.length === 0) {
    return (
      <Notice tone="info" title="No courses yet">
        You are not assigned to any course. Ask the person who runs ScanIn to assign you.
      </Notice>
    );
  }
  return (
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
  );
}
