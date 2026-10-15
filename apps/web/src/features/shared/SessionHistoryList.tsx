import { useMemo, useState } from 'react';
import type { CourseSession, Outcome } from '../../api/lecturer';
import { formatDate } from '../../components/format';
import { Badge, Button, EmptyState, SearchField, SelectField } from '../../components/ui';
import {
  INVALIDATION_LABEL,
  ATTENDANCE_OUTCOME_HELP,
  ATTENDANCE_OUTCOME_HELP_LECTURER,
  ATTENDANCE_OUTCOME_LABEL,
  ATTENDANCE_OUTCOME_TONE,
  SPOT_STATE_LABEL,
  SPOT_STATE_TONE,
} from '../lecturer/labels';
import { ReviewNotice } from './ReviewNotice';

/** What a lecturer additionally sees about each session of one student. */
export interface LecturerExtras {
  flagged?: boolean;
  verification?: string | null;
}

const PAGE = 30;

const FILTER_OUTCOMES: Outcome[] = [
  'CONFIRMED',
  'PROVISIONAL',
  'AWAITING_CONFIRMATION',
  'INVALIDATED',
  'NO_RECORD',
  'IN_PROGRESS',
  'NOT_COUNTED',
];

/**
 * One course's sessions for one student, newest first. Searchable, filterable by outcome, and each
 * session opens to say what it means. The student's view never shows flags or other students; the
 * lecturer's view adds only what a lecturer is allowed to see.
 */
export function SessionHistoryList({
  sessions,
  audience,
  onChanged,
}: {
  sessions: Array<CourseSession & LecturerExtras>;
  audience: 'student' | 'lecturer';
  onChanged: () => void;
}) {
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<'ALL' | Outcome>('ALL');
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter(
      (s) =>
        (outcome === 'ALL' || s.outcome === outcome) &&
        (q === '' || `${s.title} ${s.date} ${formatDate(s.date)}`.toLowerCase().includes(q)),
    );
  }, [sessions, query, outcome]);

  if (sessions.length === 0) {
    return (
      <EmptyState title="No sessions yet">
        No session has started in this course. They will appear here as they are held.
      </EmptyState>
    );
  }

  const help = audience === 'student' ? ATTENDANCE_OUTCOME_HELP : ATTENDANCE_OUTCOME_HELP_LECTURER;
  const visible = shown.slice(0, limit);

  return (
    <div className="stack">
      <div className="toolbar">
        <SearchField
          label="Search sessions"
          value={query}
          onChange={setQuery}
          placeholder="Title or date"
        />
        <SelectField
          label="Show"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as 'ALL' | Outcome)}
        >
          <option value="ALL">All sessions</option>
          {FILTER_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {ATTENDANCE_OUTCOME_LABEL[o]}
            </option>
          ))}
        </SelectField>
      </div>

      {shown.length === 0 ? (
        <EmptyState title="No sessions match">
          Try a different search or show all sessions.
        </EmptyState>
      ) : (
        <>
          <p className="subtle" role="status">
            Showing {visible.length} of {shown.length} {shown.length === 1 ? 'session' : 'sessions'}
          </p>
          <ul className="card card--flush rowlist" aria-label="Sessions">
            {visible.map((s) => {
              const expanded = open === s.id;
              const detailsId = `session-details-${s.id}`;
              return (
                <li key={s.id}>
                  <div className="row row--static">
                    <div className="row__main">
                      <span className="row__title">{s.title}</span>
                      <span className="row__meta">{formatDate(s.date)}</span>
                    </div>
                    <div className="cluster">
                      <span className="badges">
                        <Badge tone={ATTENDANCE_OUTCOME_TONE[s.outcome]}>
                          {ATTENDANCE_OUTCOME_LABEL[s.outcome]}
                        </Badge>
                        {s.review?.state === 'OPEN' && <Badge tone="attention">Under review</Badge>}
                        {audience === 'lecturer' && s.flagged && (
                          <Badge tone="attention">Flagged</Badge>
                        )}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={expanded}
                        aria-controls={detailsId}
                        aria-label={`${expanded ? 'Hide' : 'Show'} details for ${s.title}, ${formatDate(s.date)}`}
                        onClick={() => setOpen(expanded ? null : s.id)}
                      >
                        {expanded ? 'Hide details' : 'Details'}
                      </Button>
                    </div>
                  </div>
                  {expanded && (
                    <div id={detailsId} className="stack row__details">
                      <p>{help[s.outcome]}</p>
                      {s.source && (
                        <p className="subtle">
                          Recorded by:{' '}
                          {s.source === 'QR_SCAN'
                            ? 'QR code scan'
                            : audience === 'student'
                              ? 'marked present by your lecturer'
                              : 'marked present by a lecturer'}
                          .
                        </p>
                      )}
                      {s.outcome === 'INVALIDATED' && s.invalidationCategory && (
                        <p className="subtle">
                          Reason given:{' '}
                          {INVALIDATION_LABEL[s.invalidationCategory] ?? s.invalidationCategory}.
                          {audience === 'student'
                            ? ' Ask your lecturer if you have questions.'
                            : ''}
                        </p>
                      )}
                      {audience === 'lecturer' &&
                        s.verification &&
                        s.verification !== 'PENDING' && (
                          <p className="cluster subtle">
                            Spot check:{' '}
                            <Badge tone={SPOT_STATE_TONE[s.verification] ?? 'neutral'}>
                              {SPOT_STATE_LABEL[s.verification] ?? s.verification}
                            </Badge>
                          </p>
                        )}
                      {audience === 'student' && s.review && (
                        <ReviewNotice review={s.review} onSent={onChanged} />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {shown.length > visible.length && (
            <div className="actions">
              <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>
                Show more sessions
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
