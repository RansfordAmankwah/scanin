import { useEffect, useState } from 'react';
import { billingApi, type BillingState } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import { formatDate } from '../../components/format';
import { Badge, Button, Card, Loading, Notice, PageHeader } from '../../components/ui';
import { HOME_PATH } from '../../router';

function money(minor: number, currency: string): string {
  const amount = (minor / 100).toFixed(2);
  return currency === 'GHS' ? `GH₵${amount}` : `${currency} ${amount}`;
}

function StatusLine({ s }: { s: BillingState }) {
  switch (s.reason) {
    case 'EXEMPT':
      return (
        <Notice tone="success" title="Free access">
          This account is exempt from billing. You can run sessions without a subscription.
        </Notice>
      );
    case 'TRIAL':
      return (
        <Notice tone="info" title="Free trial">
          Your trial runs until {s.trialEndsAt ? formatDate(s.trialEndsAt) : 'soon'}. Subscribe any
          time to keep running sessions after it ends.
        </Notice>
      );
    case 'TRIAL_NOT_STARTED':
      return (
        <Notice tone="info" title="Your free trial is ready">
          Your 14-day free trial starts the first time you run a session. Until then nothing is
          counted.
        </Notice>
      );
    case 'SUBSCRIBED':
      return (
        <Notice tone="success" title="Subscription active">
          You can run sessions until {s.currentPeriodEnd ? formatDate(s.currentPeriodEnd) : 'soon'}.
          Pay again any time to add another period.
        </Notice>
      );
    case 'EMAIL_UNVERIFIED':
      return (
        <Notice tone="warning" title="Verify your e-mail">
          Verify your e-mail to start your free trial. Until then you cannot run sessions.
        </Notice>
      );
    case 'EXPIRED':
      return (
        <Notice tone="danger" title="Subscription needed" urgent>
          Your free trial or subscription has ended. Subscribe to run sessions again. Your courses
          and records are untouched.
        </Notice>
      );
    default:
      return (
        <Notice tone="info" title="Billing is off">
          No subscription is required to run sessions right now.
        </Notice>
      );
  }
}

/** A lecturer's subscription: current state and a way to pay for another period via Paystack. */
export function BillingPage() {
  const [state, setState] = useState<BillingState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void billingApi.status().then((r) => (r.ok ? setState(r.data) : setFailed(true)));
  }, []);

  const subscribe = async () => {
    setBusy(true);
    setError(null);
    const r = await billingApi.checkout();
    if (r.ok && r.data.authorizationUrl) {
      window.location.assign(r.data.authorizationUrl);
      return; // leaving the page
    }
    setBusy(false);
    setError(
      r.ok
        ? 'Could not start the payment. Try again.'
        : r.code === 'BILLING_NOT_CONFIGURED'
          ? 'Online payment is not available yet. Contact your administrator.'
          : 'Could not start the payment. Try again.',
    );
  };

  return (
    <AppShell width="medium">
      <PageHeader
        title="Subscription"
        breadcrumbs={[
          { label: 'Home', to: HOME_PATH },
          { label: 'Account', to: '/account' },
          { label: 'Subscription' },
        ]}
      />
      {failed && <Notice tone="danger" title="Could not load your subscription" urgent />}
      {!failed && !state && <Loading label="Loading…" />}
      {state && (
        <>
          <StatusLine s={state} />
          {state.reason !== 'BILLING_DISABLED' && state.reason !== 'EXEMPT' && (
            <Card
              title="ScanIn for lecturers"
              description="Students never pay. One payment adds a month; pay again any time."
            >
              <p className="cluster">
                <strong>{money(state.priceMinor, state.currency)}</strong>
                <Badge tone="neutral">per month</Badge>
              </p>
              {error && <Notice tone="danger" title={error} urgent />}
              <div className="actions">
                <Button onClick={() => void subscribe()} disabled={busy}>
                  {busy
                    ? 'Starting…'
                    : state.reason === 'SUBSCRIBED'
                      ? 'Add another month'
                      : 'Subscribe'}
                </Button>
              </div>
              <p className="muted">You will be taken to Paystack to pay by Mobile Money or card.</p>
            </Card>
          )}
        </>
      )}
    </AppShell>
  );
}
