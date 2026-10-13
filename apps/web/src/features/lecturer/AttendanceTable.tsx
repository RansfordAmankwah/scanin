import type { Counts, SessionRoster } from '../../api/lecturer';
import { RecordActions } from './RecordActions';
import { Badge } from '../../components/ui';
import {
  associationLabel,
  associationTone,
  FLAG_LABEL,
  SOURCE_LABEL,
  SPOT_STATE_LABEL,
  SPOT_STATE_TONE,
  STATUS_LABEL,
  STATUS_TONE,
} from './labels';

export function CountsPanel({ counts }: { counts: Counts }) {
  return (
    <section className="card" aria-labelledby="counts-heading">
      <h2 id="counts-heading">Attendance counts</h2>
      <dl className="counts">
        <div>
          <dt>Present (all)</dt>
          <dd>{counts.presentTotal}</dd>
        </div>
        <div>
          <dt>Confirmed</dt>
          <dd>{counts.confirmed}</dd>
        </div>
        <div>
          <dt>Provisional</dt>
          <dd>{counts.provisional}</dd>
        </div>
        <div>
          <dt>Needs review</dt>
          <dd>{counts.reviewRequired}</dd>
        </div>
        <div>
          <dt>Invalidated</dt>
          <dd>{counts.invalidated}</dd>
        </div>
      </dl>
      <p className="muted">
        Present = confirmed + provisional + needs review. Invalidated records are not counted as
        present. Of the present records, <strong>{counts.flaggedPresent}</strong> have an open flag
        (shown for information; not added to any total).
      </p>
      <p className="muted">
        “Confirmed” means matched to your class list or confirmed by you. Student IDs and names are
        self-reported, so a match is not proof of who holds the phone.
      </p>
    </section>
  );
}

/** Who attended and in what state. Scan times are intentionally not shown here (see scan history). */
export function AttendanceTable({
  roster,
  courseId,
  sessionId,
  onChanged,
}: {
  roster: SessionRoster;
  courseId: string;
  sessionId: string;
  onChanged: () => void;
}) {
  return (
    <section className="card" aria-labelledby="attendance-heading">
      <h2 id="attendance-heading">Attendance</h2>
      {roster.records.length === 0 ? (
        <p className="muted">No one has checked in yet.</p>
      ) : (
        <table className="responsive">
          <thead>
            <tr>
              <th scope="col">Student ID</th>
              <th scope="col">Name</th>
              <th scope="col">Attendance</th>
              <th scope="col">Recorded by</th>
              <th scope="col">Class-list match</th>
              <th scope="col">Flags</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {roster.records.map((r) => (
              <tr key={r.attendanceId}>
                <td data-label="Student ID">{r.studentId}</td>
                <td data-label="Name">{r.fullName}</td>
                <td data-label="Attendance">
                  <span className="badges">
                    <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>
                      {STATUS_LABEL[r.status]}
                    </Badge>
                    {r.verification && r.verification !== 'PENDING' && (
                      <Badge tone={SPOT_STATE_TONE[r.verification] ?? 'neutral'}>
                        {SPOT_STATE_LABEL[r.verification]}
                      </Badge>
                    )}
                    {r.disputeState === 'OPEN' && <Badge tone="attention">Under review</Badge>}
                  </span>
                </td>
                <td data-label="Recorded by">{SOURCE_LABEL[r.source]}</td>
                <td data-label="Class-list match">
                  <Badge tone={associationTone(r.associationState)}>
                    {associationLabel(r.associationState, r.associationBasis)}
                  </Badge>
                </td>
                <td data-label="Flags">
                  {r.flagKinds.length ? r.flagKinds.map((k) => FLAG_LABEL[k] ?? k).join(', ') : '—'}
                </td>
                <td data-label="Actions">
                  <RecordActions
                    courseId={courseId}
                    sessionId={sessionId}
                    record={r}
                    onChanged={onChanged}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {roster.noRecord.length > 0 && (
        <>
          <h3>On the class list, no record for this session</h3>
          <ul className="list">
            {roster.noRecord.map((e) => (
              <li key={e.entryId}>
                {e.studentId} {e.fullName}{' '}
                <span className="muted">{e.registered ? '' : '(no account yet)'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
