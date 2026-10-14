# Freedom Pay audit — 14 October 2026

## Verified against the running services

- BasQar owner checkout for BSQ-2026-000005 creates a Freedom Pay session and opens the provider's card form with the correct 69,990 KZT amount. No card data entered and no payment submitted during this check.
- Freedom Pay settings identify BasQar merchant 590285 under account 81323 as **test mode**. The developer page supplies test cards and says live activation requires the merchant's Freedom Pay manager.
- The previous payment 1868517257 (8 October) appears with status `error`; the newly created payment 1872383801 appears with status `waiting`. This is not proof of successful payment acceptance.
- A status check before entering the card produced an unnecessary reconciliation message in BasQar.
- Returning with browser Back exposed an obsolete lazy JavaScript chunk. Its URL returned HTML with HTTP 200. Reloading the page recovered it.

## Corrections

- Checkout reads use request versions; older responses cannot overwrite a later payment confirmation or introduce a stale error. Successful recovery clears the network error without hiding an action error.
- `pg_result=2` is acknowledged as unfinished, preserves the payment lock, records the verified provider payment ID and deduplicates the notice. Later success/failure is processed normally; an unfinished notice cannot reopen a terminal payment.
- `waiting` and `partial` statuses remain pending rather than incorrectly demanding administrator reconciliation.
- Status responses with a different merchant/test mode are rejected when those fields are present. Failed/expired responses with contradictory capture/result/settlement evidence cannot unlock a second attempt.
- Checkout exposes the test-mode flag and shows a clear warning for card payments.
- Application HTML is served with `Cache-Control: no-store`; missing `/assets` files return 404 instead of the application HTML. Existing tabs can require a reload after deployment.

## Validation

- Seven API suites passed on isolated databases with external providers disabled: billingProvider, billingCheckout, billingCheckoutHttp, billingSaas, billingHttpV4, billingPublicV4, webAssetDelivery.
- New regression cases failed before the corresponding corrections and passed after them.
- Web tests: 38 passed. API/web type checks and the production web build passed. Vite still reports the existing large-chunk size warning.
- No Docker verification (the user previously requested checking without Docker).

## Remaining acceptance check

A successful sandbox card transaction, signed callback delivery and automatic subscription activation still need to be observed together on the deployed service. Completing the current test order can change CREOLAB's subscription, so it must not be submitted silently. No live-mode switch, real charge, refund, merchant secret rotation or support message was performed.

## Protocol sources

- https://docs.freedompay.kz/status-11620963e0
- https://docs.freedompay.kz/result-notify-12007677e0
- https://freedompay.kz/docs/merchant-api/pay — `pg_result=2`, repeated result notifications and terminal/payment states.
