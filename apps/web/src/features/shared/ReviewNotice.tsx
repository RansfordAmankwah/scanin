import { useState } from 'react';
import { studentApi, type Review } from '../../api/lecturer';
import { Notice } from '../../components/ui';

const REPLY_PROBLEMS: Record<string, string> = {
  TOO_MANY_RESPONSES: 'You have added the most replies allowed. Please speak to your lecturer.',
  INVALID_TRANSITION: 'This review has already been closed.',
  RATE_LIMITED: 'Too many replies just now. Wait a moment and try again.',
  NETWORK: 'Could not reach the server. Try again.',
};

/**
 * Shown only when a lecturer is reviewing one of the student's records. It says that, that the record
 * still counts, and lets the student reply. It never says why, who else was involved, or how the
 * lecturer decided to look.
 */
export function ReviewNotice({ review, onSent }: { review: Review; onSent: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  if (review.state === 'RESOLVED_UPHELD') {
    return <p className="muted">Your lecturer reviewed this record and it stands.</p>;
  }
  if (review.state === 'RESOLVED_INVALIDATED') {
    return (
      <p className="muted">Your lecturer reviewed this record. Ask them if you have questions.</p>
    );
  }

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await studentApi.respondToReview(review.id, text.trim());
    setBusy(false);
    if (r.ok) {
      setText('');
      setMessage({ tone: 'success', text: 'Your reply was sent to your lecturer.' });
      onSent();
    } else {
      setMessage({ tone: 'danger', text: REPLY_PROBLEMS[r.code] ?? 'Could not send your reply.' });
    }
  };

  return (
    <div className="stack">
      <Notice tone="info" title="Your lecturer is reviewing this record">
        It still counts as present while they look at it. You can add a note below, and you can also
        speak to your lecturer.
      </Notice>
      {review.repliesLeft > 0 ? (
        <form className="stack" onSubmit={(e) => void send(e)} aria-label="Reply about this record">
          <div className="field">
            <label htmlFor={`reply-${review.id}`}>Your reply</label>
            <textarea
              id={`reply-${review.id}`}
              rows={3}
              maxLength={1000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="actions">
            <button type="submit" className="btn" disabled={busy || !text.trim()}>
              {busy ? 'Sending…' : 'Send reply'}
            </button>
          </div>
        </form>
      ) : (
        <p className="muted">You have used all your replies. Please speak to your lecturer.</p>
      )}
      {message && (
        <Notice tone={message.tone} title={message.text} urgent={message.tone === 'danger'} />
      )}
    </div>
  );
}
