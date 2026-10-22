# First launch assistant — 2026-10-21

New self-registered companies open `/start` after email verification. Free accounts now start with onboarding enabled. Existing companies can open “Начало работы” from the desktop navigation or mobile “Ещё”; they are not forcibly redirected into setup.

## User journey

- Choose the first channel: WhatsApp, Telegram, Instagram, website chat or website form.
- Choose AI with staff handoff or staff-only replies. A form uses the staff workflow.
- Connect the selected channel. For AI, publish business knowledge and save reply rules before testing an inbound exchange.
- The contextual helper links to the relevant settings and highlights their location with “Показать где”. It remains in the page flow, without an overlay covering mobile inputs. It supports reduced motion and the current color theme.
- Continue later without falsely completing any steps. Saved choices survive reloads; changing the route requires a new test.
- Team invitations, legal details and Control are optional next steps.

Choosing a route never enables AI, connects a provider or sends a message. Plan restrictions are visible before opening a paid feature. RU/KK copy uses the shared product localization mechanism.

## Verified progress

`GET/PATCH /api/v1/workspace/onboarding` requires an active company owner/director context. Progress is calculated from tenant-scoped records; the client cannot submit completion flags. Preferences use a tenant row lock and preserve unrelated settings.

- Connection: active integration with connected status and at least one active channel binding. Website forms require an active integration and an active form definition.
- Knowledge: published company prompt and published knowledge.
- Rules: an actual saved automation configuration audit event. This step means rules were saved; it does not claim the AI is currently replying.
- Test: fresh, non-historical, non-internal inbound from the selected channel since setup began, followed by an accepted/sent response in that conversation. AI workflow verifies an AI response; staff workflow verifies a staff response. Failed, queued, internal, historical and handoff-acknowledgement messages do not count. Website forms require a fresh inquiry, without an outbound message. Subsequent unanswered conversations do not erase a successful test.
- Final completion is rechecked on the server before saving the completed status. Disconnected channels can still be shown as requiring attention.

The legacy “complete-step” endpoint no longer marks a step complete on a settings link click. No schema migration, real messages or production configuration changes were needed.

## Validation

- 10 onboarding tests: Free registration defaults, resume/defer, actual connections, missing/disabled bindings across all four chat channels, fresh messages, tenant isolation, published knowledge/rules, successful AI/staff sends, route switching, inactive forms and rejected fabricated progress.
- 4 self-registration tests, including HTTP persistence and validation of the new endpoint.
- 10 SaaS billing regression tests.
- API/web typechecks, web production build and bundle budget passed. Existing large-chunk build warning remains.
- Browser visual verification is pending: CUA reports that local browser use is disabled in Work settings.
- Local preview restarted with the existing disposable database at `http://127.0.0.1:4495/start`. Not deployed to production.

## Follow-up audit

- Removed the inherited 440px form width; channel cards now use responsive columns, readable typography and compact spacing.
- Cancelling route editing no longer retains the cancelled selection on reopening.
- Reproduced four failing server test cases before correcting connection/form readiness and staff response verification. Final run: 24/24 tests passed across onboarding, registration and SaaS billing.
- API/web typechecks and production build passed after the fixes. Browser automation remains disabled in Work settings, so interactive visual verification and live-provider exchange are not claimed.
