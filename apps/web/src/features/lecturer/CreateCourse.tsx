import { useEffect, useId, useState } from 'react';
import { lecturerApi, type Course, type TermView } from '../../api/lecturer';
import { Notice, TextField } from '../../components/ui';

const NEW_TERM = 'new';

const PROBLEMS: Record<string, string> = {
  INVALID_TERM:
    'Check the term: it needs a name, an end date after its start date, a length of about a year at most, and an end date within the next two years.',
  INVALID_COURSE: 'Enter a course code (up to 32 characters) and a title.',
  INVALID_REQUEST: 'Check the form and try again.',
  TERM_EXISTS: 'You already have a term with that name. Choose it from the list.',
  COURSE_EXISTS: 'A course with that code already exists in that term.',
  TERM_NOT_FOUND: 'That term is no longer available. Choose another.',
  RATE_LIMITED: 'You have created a lot of courses just now. Try again later.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
};

/** Creates a course (and optionally a term of the lecturer's own) and assigns the lecturer to it. */
export function CreateCourse({ onCreated }: { onCreated: (course: Course) => void }) {
  const termId = useId();
  const [terms, setTerms] = useState<TermView[] | null>(null);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [term, setTerm] = useState(NEW_TERM);
  const [termName, setTermName] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void lecturerApi.terms().then((r) => {
      if (cancelled) return;
      const list = r.ok ? r.data.terms : [];
      setTerms(list);
      if (list[0]) setTerm(list[0].id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await lecturerApi.createCourse({
      code,
      title,
      ...(term === NEW_TERM ? { newTerm: { name: termName, startsOn, endsOn } } : { termId: term }),
    });
    setBusy(false);
    if (r.ok) {
      setCode('');
      setTitle('');
      onCreated(r.data.course);
    } else {
      setError(PROBLEMS[r.code] ?? 'Could not create the course. Please try again.');
    }
  };

  return (
    <section className="card" aria-labelledby="create-course-heading">
      <h2 id="create-course-heading">Create a course</h2>
      <form className="stack" onSubmit={(e) => void submit(e)} aria-label="Create course">
        <TextField
          label="Course code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. CS101"
          required
        />
        <TextField
          label="Course title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Introduction to Computing"
          required
        />
        <div className="field">
          <label htmlFor={termId}>Term</label>
          <select
            id={termId}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            disabled={terms === null}
          >
            {(terms ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.startsOn} to {t.endsOn})
              </option>
            ))}
            <option value={NEW_TERM}>New term…</option>
          </select>
        </div>
        {term === NEW_TERM && (
          <>
            <TextField
              label="Term name"
              value={termName}
              onChange={(e) => setTermName(e.target.value)}
              placeholder="e.g. Fall 2026"
              required
            />
            <TextField
              label="Term starts on"
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
              required
            />
            <TextField
              label="Term ends on"
              type="date"
              value={endsOn}
              onChange={(e) => setEndsOn(e.target.value)}
              hint="Class data is kept until one year after this date, then deleted."
              required
            />
          </>
        )}
        {error && <Notice tone="danger" title={error} urgent />}
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Creating…' : 'Create course'}
        </button>
      </form>
    </section>
  );
}
