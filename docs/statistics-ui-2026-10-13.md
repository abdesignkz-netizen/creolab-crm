# Statistics workspace redesign — 13 October 2026

Implemented locally; not deployed. Browser verification used a separate PGlite database and local API with external providers disabled.

## Changes

- Four primary metrics, a compact secondary row, interactive trend, actionable report shortcuts, funnel and source/service rankings.
- Explicit filter application, removable filter chips, clear reset, comparison period and refresh status.
- All eleven reports retained. Compact report selector on phones and tablets; detailed tables scroll within their own container.
- Chart metrics switch from one dashboard snapshot without another request. Revenue includes currency; absent daily conversion stays absent rather than becoming zero.
- Native accessible dialogs with Escape/focus containment. Closing a detail request prevents its late response from reopening the dialog.
- Initial custom date selection shows guidance; incomplete/invalid ranges do not present stale results. Empty filters explain how to recover.
- Russian/Kazakh product copy, theme variables, reduced-motion support, mobile input sizes that avoid automatic iOS zoom.

## Verification

- Web typecheck and production build passed. Existing large-bundle warning remains.
- All 34 web tests passed.
- API auditRegression and periodRange: 14 tests passed across two isolated test databases. Added coverage confirming all six dashboard chart metrics match dedicated trend results, including comparison and missing conversion values.
- Browser: source filtering changed 60 inquiries to 15; removing the filter restored 60. Comparison and revenue switching, detail dialog (60 records), Escape, export dialog, empty filter and custom range verified.
- All eleven mobile reports opened at 390px without page overflow. Also checked 320px, 768px and default 1280px; fixed tablet grid sizing and tab shrinking discovered during inspection.
- Revenue chart touch readout showed the selected day's amount and currency. No browser errors in the final local preview.

Screenshots and the running local preview contain synthetic demonstration data, not production analytics. Export-file generation and dark-theme visual inspection were not part of this browser pass.
