import test from 'node:test';
import assert from 'node:assert/strict';
import { billingCheckoutState } from '../apps/web/src/lib/billingCheckoutState.ts';

const now = Date.parse('2026-10-08T10:00:00Z');
const checkout = (statuses, expiresAt = '2026-10-09T10:00:00Z', status = 'PENDING_PAYMENT') => ({
  order: { status, expiresAt }, payments: statuses.map(status => ({ status })),
});

test('expired unresolved card payment remains visible and refreshes without allowing a new attempt', () => {
  assert.deepEqual(billingCheckoutState(checkout(['PROCESSING'], '2026-10-07T10:00:00Z'), false, now), {
    canStartPayment: false, showPaymentFlow: true, shouldRefresh: true,
  });
});

test('manual pending payment refreshes when its link or confirmation can arrive', () => {
  assert.equal(billingCheckoutState(checkout(['PENDING']), false, now).shouldRefresh, true);
  assert.equal(billingCheckoutState(checkout(['FAILED']), false, now).shouldRefresh, false);
});

test('closed orders stop refresh even after provider return and cannot reopen a payment', () => {
  for (const status of ['PAID', 'CANCELLED', 'EXPIRED']) {
    assert.deepEqual(billingCheckoutState(checkout(['PROCESSING'], undefined, status), true, now), {
      canStartPayment: false, showPaymentFlow: false, shouldRefresh: false,
    });
  }
  assert.deepEqual(billingCheckoutState(checkout([], '2026-10-07T10:00:00Z'), false, now), {
    canStartPayment: false, showPaymentFlow: false, shouldRefresh: false,
  });
});
