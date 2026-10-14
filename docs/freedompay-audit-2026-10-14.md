# Freedom Pay audit — 14 October 2026

## Verified against the running services

- BasQar owner checkout for BSQ-2026-000005 creates a Freedom Pay session and opens the provider's card form with the correct 69,990 KZT amount. The initial inspection did not submit a payment; the explicitly approved sandbox acceptance check below completed it.
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

## Deployed acceptance check

- Fix commit `499f6ad` is deployed. The production asset bundle matches the tested build, HTML is `no-store`, the obsolete checkout asset returns 404, and `/health` and `/ready` pass.
- A live status check for the unfinished attempt now reports pending without the false reconciliation error. The browser console has no errors on the reloaded checkout.
- The user explicitly approved completing BSQ-2026-000005 and changing CREOLAB's Full subscription to Pro.
- The old attempt 1872383801 expired with provider code `10018`. On return, BasQar released the attempt and offered a fresh card payment for the same order without administrator intervention.
- New payment **1872420498**, merchant reference `d7f95a73-8cc5-4bb3-96e6-76ce30e80470`, succeeded at **14 October 2026, 18:08:45** (provider UI). Only the official successful sandbox card ending **1111** and synthetic test contact data were used.
- BasQar automatically showed **Paid / Payment confirmed**, activated **BasQar Pro until 14 November 2026**, and marked invoice **BSQ-INV-2026-000003** paid. Reopening the checkout without bank return parameters preserved the confirmed result. This verifies the bank-to-BasQar confirmation path, rather than relying on a browser return flag.
- The provider's official test-card table assigns card ending **6666** to error **99999**. The earlier user-reported rejection with that card is the configured negative test scenario, not evidence of a checkout defect.

The merchant remains in **test mode**. Real card acceptance still requires Freedom Pay to activate the merchant and the application to use live mode. No live-mode switch, real charge, refund, merchant secret rotation or support message was performed.

## Protocol sources

- https://docs.freedompay.kz/status-11620963e0
- https://docs.freedompay.kz/result-notify-12007677e0
- https://freedompay.kz/docs/merchant-api/pay — `pg_result=2`, repeated result notifications and terminal/payment states.
