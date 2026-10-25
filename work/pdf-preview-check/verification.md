# PDF viewer correction — 2026-10-23

Published commit: `8f66fd3`.

Reproduced the old viewer on a local production build with the service CSP: passing a blob URL to PDF.js produced `ResponseException: Unexpected server response (0)`, then silently selected an empty native PDF object. Fetching that URL also failed in this browser under the same headers. Direct Blob.arrayBuffer input renders successfully without changing security headers.

Fixed all four shared viewer callers (AVR, invoice, contract, public signature page); removed forced native Safari mode. Added bounded loading/rendering, cancellation, retry, open/download links, responsive fitting and current-AVR preview invalidation.

Verified in Chrome: visible PDF canvas, two pages, next page, zoom, damaged-file error, retry. Browser access was subsequently disabled, so narrow-screen and actual Safari checks remain unverified. The production session had expired; no customer documents were modified.

Checks passed: web typecheck and production build; 30 targeted web tests including six PDF source tests; 28 AVR API/generation tests with isolated databases.

The full web suite has an existing failure in scripts/system-locale.test.mjs: its dictionary AST parser does not support the onboarding dictionary spread. It was already broken before this patch; temporary diagnostic changes to that test were reverted.

Live verification: root loads index-B_EklPWI.js; PDF viewer and AVR editor assets match the local build by SHA-256; /ready returns ready. No dependencies or CSP changes.

The local preview server on port 4509 is stopped. To repeat the UI check, run `node work/pdf-preview-check/serve.mjs`.
