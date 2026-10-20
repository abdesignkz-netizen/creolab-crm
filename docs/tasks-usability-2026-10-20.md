# Tasks and campaign diagnostics — 20 October 2026

The task list separates work category from deadline/status: clients, documents and estimates, payments, internal work, and campaigns. The default view contains unfinished work, including waiting tasks; closed and cancelled tasks remain in Archive. Names and validated phone numbers appear in collapsed cards, including WhatsApp-only contact numbers. Phone search ignores display punctuation.

The create form offers six intent templates with examples. Client context and outbound message preparation are optional disclosures. Saving creates the task and its message draft together, without sending or scheduling messages. The same draft is saved on grouped child tasks. Slow contact-context requests no longer overwrite a subsequently selected client or a newly typed task title.

Campaign history is available independently of tasks and the compose panel, with pagination and recipient failure/skip reasons. It is scoped to the current company and uses the existing campaign role restrictions. Opening history performs no sends or retries. Campaign recipient selection accepts valid WhatsApp contact methods and rejects opaque WhatsApp IDs.

Task list/details now select only the owner fields required for presentation instead of serializing the complete user record.

Validation:
- Campaign API tests cover WhatsApp-only phones, rejection of LIDs, cross-company isolation, failed history, read-only inspection, and exclusion of password hashes.
- Task targeting/execution/result tests cover draft creation and the existing execution lifecycle.
- Presentation tests cover categories, phone searches, translated generated titles, default active view, archive, and preserving user-authored titles.
- API/web type checks and the production web build pass.
- An isolated preview is available through `scripts/tasks-ui-smoke.mts`. External providers and background sends are disabled. Browser visual inspection remains pending while browser control is disabled in Work settings.

Incident investigation: the October 19 campaign `6fe5fa37-0a9a-411f-8bed-f8f75754b6a2` has two failed recipients and zero sends. Both failures are `Green API HTTP 401`. Recipient phone numbers were valid. CREOLAB's active WhatsApp connection is QR, but campaigns were hardcoded to the legacy seller/Green API transport. The invitation refers to an expired meeting time; no production messages were resent.

Campaign routing now selects the connected WhatsApp number when creating a draft and shows the sender during confirmation. Multiple direct connections require an explicit choice. The selected connection is included in the confirmation hash; existing campaigns retain their original transport and never silently fall back to another provider.

Direct sends use the existing durable WhatsApp outbox, with a stable campaign/recipient key. Queue replay does not create a second contact, conversation, or send. Recipients remain “sending” until WhatsApp accepts the message. Unknown outcomes and partial sends require conversation review rather than automatic retry. Cancellation, pause/resume, employee takeover, permissions and Cloud API's existing 24-hour window are respected. Partly completed personalized campaigns can resume without invalidating their original confirmation.

Additional checks use an isolated database and a fake WhatsApp socket: QR selection, concurrent queue replay, imports by phone, provider uncertainty, partial attachments, cancellation, pause/resume, changed permissions, exact recipient numbers, disconnected senders, tenant isolation and Cloud API window enforcement. The existing WhatsApp and task execution regression suites also pass. Live end-to-end delivery still requires a new, explicitly approved test message.
