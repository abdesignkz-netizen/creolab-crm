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

Incident investigation: production task/audit reads did not identify the reported October 19 campaign. The exact two recipient errors must be read from the new campaign history once deployed (or from a campaign ID supplied by the owner). The WhatsApp phone selection bug is confirmed in code/tests, but is not yet established as the cause of that particular campaign.
