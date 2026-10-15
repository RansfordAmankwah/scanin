import { useState } from 'react';
import { courseApi } from '../../api/lecturer';
import { Badge, Card, EmptyState, ErrorState, Loading } from '../../components/ui';
import { useLoad } from '../../components/useLoad';
import { LINK_STATE_LABEL, LINK_STATE_TONE } from './labels';
import { RosterImport } from './RosterImport';

/** The class list: who is on it, and how to change it. Changes are previewed before anything is applied. */
export function ClassListTab({ courseId, onApplied }: { courseId: string; onApplied: () => void }) {
  const [version, setVersion] = useState(0);
  const list = useLoad(() => courseApi.classList(courseId), [courseId, version]);

  return (
    <div className="stack stack--loose">
      <RosterImport
        courseId={courseId}
        onApplied={() => {
          setVersion((v) => v + 1);
          onApplied();
        }}
      />

      <Card
        flush
        title="Who is on the class list"
        description="A student is confirmed when their ID or verified e-mail matches an entry here."
      >
        {list.state.status === 'loading' && (
          <div className="card__pad">
            <Loading label="Loading the class list…" />
          </div>
        )}
        {(list.state.status === 'error' || list.state.status === 'not-found') && (
          <div className="card__pad">
            <ErrorState title="Could not load the class list" onRetry={() => void list.reload()} />
          </div>
        )}
        {list.state.status === 'ready' && !list.state.data.hasRoster && (
          <div className="card__pad">
            <EmptyState title="No class list yet">
              Upload one above. Until then, students who check in are recorded as not yet confirmed.
            </EmptyState>
          </div>
        )}
        {list.state.status === 'ready' && list.state.data.hasRoster && (
          <table className="responsive">
            <thead>
              <tr>
                <th scope="col">Student ID</th>
                <th scope="col">Name</th>
                <th scope="col">E-mail</th>
                <th scope="col">Account</th>
                <th scope="col">Match</th>
              </tr>
            </thead>
            <tbody>
              {list.state.data.entries.map((e) => (
                <tr key={e.id}>
                  <td data-label="Student ID">{e.studentId}</td>
                  <td data-label="Name">{e.fullName}</td>
                  <td data-label="E-mail">{e.schoolEmail ?? '—'}</td>
                  <td data-label="Account">
                    <Badge tone={e.registered ? 'success' : 'neutral'}>
                      {e.registered ? 'Has an account' : 'No account yet'}
                    </Badge>
                  </td>
                  <td data-label="Match">
                    {e.link ? (
                      <Badge tone={LINK_STATE_TONE[e.link.state]}>
                        {LINK_STATE_LABEL[e.link.state]}
                      </Badge>
                    ) : (
                      <span className="subtle">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {list.state.status === 'ready' && list.state.data.unmatchedLinks.length > 0 && (
        <Card
          flush
          title="Checked in, but not on the class list"
          description="These students identified themselves; ScanIn has not matched them to an entry."
        >
          <table className="responsive">
            <thead>
              <tr>
                <th scope="col">Student ID</th>
                <th scope="col">Name</th>
                <th scope="col">Match</th>
              </tr>
            </thead>
            <tbody>
              {list.state.data.unmatchedLinks.map((u) => (
                <tr key={u.linkId}>
                  <td data-label="Student ID">{u.studentId}</td>
                  <td data-label="Name">{u.fullName}</td>
                  <td data-label="Match">
                    <Badge tone={LINK_STATE_TONE[u.state]}>{LINK_STATE_LABEL[u.state]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
