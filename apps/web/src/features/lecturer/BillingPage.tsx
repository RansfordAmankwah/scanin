import { useEffect, useState } from 'react';
import { billingApi, type BillingState } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import { formatDate } from '../../components/format';
import { Badge, Button, Loading, Notice, PageHeader } from '../../components/ui';

function money(minor: number, currency: string): string {
  const amount = (minor / 100).toFixed(2);
  return currency === 'GHS' ? `GHS ${amount}` : `${currency} ${amount}`;
}

function moneyDisplay(minor: number, currency: string): { big: string; unit: string } {
  const amount = (minor / 100).toFixed(2);
  if (currency === 'GHS') return { big: `GH₵${amount}`, unit: 'per month' };
  return { big: `${currency} ${amount}`, unit: 'per month' };
}

function PlanCard({ s }: { s: BillingState }) {
  const { big, unit } = moneyDisplay(s.priceMinor, s.currency);
  const isActive = s.reason === 'SUBSCRIBED';
  const isTrial = s.reason === 'TRIAL' || s.reason === 'TRIAL_NOT_STARTED';

  return (
    <div className="billing-plan">
      <div className="billing-plan__header">
        <span className="billing-plan__label">LECTURER PLAN</span>
        {isActive && <Badge tone="success">Active</Badge>}
        {isTrial && <Badge tone="info">Trial</Badge>}
        {s.reason === 'EXPIRED' && <Badge tone="danger">Expired</Badge>}
      </div>
      <div className="billing-plan__price">
        <span className="billing-plan__amount">{big}</span>
        <span className="billing-plan__unit">{unit}</span>
      </div>
      {s.currency === 'GHS' && (
        <p className="muted">
          Card payments are charged in Ghana cedis: {money(s.priceMinor, s.currency)} per month.
        </p>
      )}
      {(isActive || isTrial) && (s.currentPeriodEnd || s.trialEndsAt) && (
        <div className="billing-plan__through">
          <span className="muted">{isTrial ? 'Trial ends' : 'Paid through'}</span>
          <strong>{formatDate((isActive ? s.currentPeriodEnd : s.trialEndsAt)!)}</strong>
        </div>
      )}
    </div>
  );
}

function StatusNotice({ s }: { s: BillingState }) {
  switch (s.reason) {
    case 'EXEMPT':
      return (
        <Notice tone="success" title="Free access">
          This account is exempt from billing. You can run sessions without a subscription.
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
      return null;
  }
}

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
      return;
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

  const canPay =
    state &&
    state.reason !== 'BILLING_DISABLED' &&
    state.reason !== 'EXEMPT' &&
    state.reason !== 'EMAIL_UNVERIFIED';

  return (
    <AppShell>
      <PageHeader title="Billing" />

      {failed && <Notice tone="danger" title="Could not load your subscription" urgent />}
      {!failed && !state && <Loading label="Loading…" />}

      {state && (
        <>
          <StatusNotice s={state} />

          <div className="billing-grid">
            <div className="billing-grid__main stack">
              {state.reason !== 'BILLING_DISABLED' && <PlanCard s={state} />}

              {canPay && (
                <section className="stack">
                  <h2>Add time</h2>
                  <div className="billing-summary">
                    <div className="billing-summary__row">
                      <span className="muted">Amount today</span>
                      <strong>{money(state.priceMinor, state.currency)}</strong>
                    </div>
                  </div>
                  {error && <Notice tone="danger" title={error} urgent />}
                  <button
                    type="button"
                    className="btn btn--block"
                    disabled={busy}
                    onClick={() => void subscribe()}
                  >
                    {busy
                      ? 'Starting…'
                      : `Pay ${money(state.priceMinor, state.currency)}`}
                  </button>
                  <p className="muted" style={{ textAlign: 'center' }}>
                    You will confirm on Paystack. A payment only counts once Paystack confirms it.
                  </p>
                </section>
              )}
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
