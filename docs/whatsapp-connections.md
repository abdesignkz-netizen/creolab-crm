# WhatsApp connections in BasQar

The Integrations page offers Green API, a direct QR session, and Meta WhatsApp Cloud API. Switching the selected setup tab does not disconnect an existing number. Every pending/active number consumes the same `WHATSAPP_CONNECTIONS` quota; disconnecting releases the slot and retains conversation history.

## Providers and current scope

| Provider | Setup | Incoming/outgoing | AI Manager |
| --- | --- | --- | --- |
| Green API | Existing Instance ID / API Token workflow | Existing seller bridge | Existing AI Manager integration |
| QR | WhatsApp → Linked devices → scan the code shown in BasQar | Direct messages and files, encrypted persistent session | BasQar AI replies using published company settings |
| Official Meta | Registered Cloud API number, WABA ID, Phone Number ID, App ID, token and secret | Signed webhooks; replies within 24 hours; files | BasQar AI replies using published company settings and the same 24-hour window |

The official flow currently connects an already configured Meta account. It is **not** Embedded Signup / a one-click Meta onboarding flow. Templates, campaigns through the new providers, group messages, calls and historical chat import are outside this implementation. Unsupported incoming formats are represented by a visible placeholder rather than silently discarded. Inbound attachments are capped at 16 MiB.

## Deployment

1. Install locked dependencies with Node 22.18 or later. Baileys is pinned to `7.0.0-rc14`; it includes a platform-specific native dependency. Test the production Linux image, not just macOS. The adapter is unofficial and separate from Meta Cloud API.
2. Generate the Prisma client. Apply `packages/db/prisma/migrations/20261004_whatsapp_providers.sql` before exposing new endpoints when using an externally managed migration process. The existing database bootstrap also applies these additive statements to PostgreSQL and PGlite.
3. Keep the existing `ENCRYPTION_KEY` stable and back it up separately from the database. QR credentials, all Signal key categories, pairing codes and pending event payloads are encrypted. Losing or changing that key requires re-pairing; normal database restore with the same key preserves sessions. Include the three `WhatsAppQr*` tables in backups and secret rotation procedures.
4. The API entrypoint starts the QR runtime. Run a persistent API process with outbound WebSocket/HTTPS connectivity to WhatsApp. `WHATSAPP_QR_ENABLED=0` disables the QR runtime and new QR setup; existing session records remain. Do not run on a sleeping/free web service for continuous reception.
5. Shared PostgreSQL leases allow multiple API replicas to coordinate ownership. Replies enter an encrypted database queue so any API replica can accept them. The owning worker renews its lease independently of media processing. A send interrupted after network dispatch becomes `unknown`; it is not automatically sent again.
6. Cloud API requires the public HTTPS `API_BASE_URL` and a registered Cloud API number. Tokens need `whatsapp_business_management` and `whatsapp_business_messaging`. Configure the generated Callback URL and Verify Token in the customer's Meta app, subscribe to `messages`, then select **Verify and enable**. This manual setup uses one WhatsApp callback per app and rejects sharing that callback with another BasQar connection.

Disconnecting QR removes server-side auth keys and queued jobs; a running owner attempts logout. If the worker was offline during disconnect, remove **BasQar** manually from WhatsApp's Linked devices. Cloud disconnect stops local reception and deletes credentials without changing other subscriptions in the customer's Meta app.

## AI replies

Enable **AI replies** separately for each connected QR/Meta number in Integrations. A published company prompt, enabled AI configuration, configured LLM credentials and the AI Manager entitlement are required. New conversations start automatically when the existing automation policy permits AUTO; existing conversations use **Return to AI**. Human takeover, the company AI pause, working hours, client overrides and channel overrides continue to apply. Enabling a number does not take existing conversations away from staff.

Generation reads the company's published prompt and knowledge, excludes internal notes and drafts, and charges through the existing AI usage/credit ledger. It produces text replies only; attachment-only messages and explicit requests for a person are handed to staff. This does not add proactive follow-ups, campaign sending or AI file interpretation.

Inbound messages enqueue durable reply jobs. Conversation control version and message revision are checked before generation and again before sending; superseded answers are canceled. A received-message pointer prevents second-precision provider timestamps from selecting the wrong question on Return to AI. Duplicate jobs share an outbound claim. Interrupted generation hands the conversation to staff instead of automatically billing again; uncertain delivery is not repeated. The existing background outbox worker must run in addition to the QR runtime.

## Test coverage

Automated API tests use a fake socket and a mocked Graph API; they never send real WhatsApp messages. They exercise webhook signatures, correct recipient routing, deduplication, Cloud reply-window restrictions, idempotency, encrypted auth round trips, lease ownership, QR display, tenant isolation, all-provider quotas and disconnect/history preservation. Existing Meta and billing tests are also run.

AI tests use a mocked LLM and verify published company context, exclusion of internal notes and drafts, usage accounting, both delivery paths, concurrent-worker deduplication, human takeover, per-number disable, newer inbound messages during generation/delivery, quiet hours, pause, expired Meta windows, Start entitlement denial and exhausted Free credits. Admin activation labels recognize QR/Meta without requiring seller-service synchronization.

Review regressions also cover queued staff replies across control changes, Meta failure receipts arriving after `sent`, and exclusion of queued/sending/canceled/failed/unknown messages from CRM analysis and follow-up context. Meta delivery failure marks the latest failed reply for staff attention without downgrading an already delivered receipt or rolling back a newer successful reply.

Before production acceptance, scan a real QR with a test number, restart the production runtime, verify message/file delivery in both directions, and revoke the device from the phone. Separately connect a real Meta business number and test a signed webhook and reply. Those checks require the account owner's phone/Meta access and have not been performed by the automated tests.

For each provider, enable AI replies on the test number and check a real reply against the published company knowledge, then take over the conversation and confirm automatic replies stop. Real LLM/provider delivery has not been exercised by local tests.

References: [Baileys session storage](https://baileys.wiki/authentication/session-management), [Meta Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api).
