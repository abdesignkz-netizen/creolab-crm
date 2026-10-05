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

Generation reads the company's published prompt and knowledge, excludes internal notes and drafts, and charges through the existing AI usage/credit ledger. It produces text replies. QR and Meta voice notes are transcribed before the reply model receives the conversation. Other attachment-only messages and explicit requests for a person are handed to staff. This does not add proactive follow-ups, campaign sending or interpretation of images, videos and documents.

Inbound messages enqueue durable reply jobs. Conversation control version and message revision are checked before generation and again before sending; superseded answers are canceled. A received-message pointer prevents second-precision provider timestamps from selecting the wrong question on Return to AI. Duplicate jobs share an outbound claim. Interrupted generation hands the conversation to staff instead of automatically billing again; uncertain delivery is not repeated. The existing background outbox worker must run in addition to the QR runtime.

## Test coverage

Automated API tests use a fake socket and a mocked Graph API; they never send real WhatsApp messages. They exercise webhook signatures, correct recipient routing, deduplication, Cloud reply-window restrictions, idempotency, encrypted auth round trips, lease ownership, QR display, tenant isolation, all-provider quotas and disconnect/history preservation. Existing Meta and billing tests are also run.

AI tests use a mocked LLM and verify published company context, exclusion of internal notes and drafts, usage accounting, both delivery paths, concurrent-worker deduplication, human takeover, per-number disable, newer inbound messages during generation/delivery, quiet hours, pause, expired Meta windows, Start entitlement denial and exhausted Free credits. Admin activation labels recognize QR/Meta without requiring seller-service synchronization.

Review regressions also cover queued staff replies across control changes, Meta failure receipts arriving after `sent`, and exclusion of queued/sending/canceled/failed/unknown messages from CRM analysis and follow-up context. Meta delivery failure marks the latest failed reply for staff attention without downgrading an already delivered receipt or rolling back a newer successful reply.

Before production acceptance, scan a real QR with a test number, restart the production runtime, verify message/file delivery in both directions, and revoke the device from the phone. Separately connect a real Meta business number and test a signed webhook and reply. Those checks require the account owner's phone/Meta access and have not been performed by the automated tests.

For each provider, enable AI replies on the test number and check a real reply against the published company knowledge, then take over the conversation and confirm automatic replies stop. Real LLM/provider delivery has not been exercised by local tests.

References: [Baileys session storage](https://baileys.wiki/authentication/session-management), [Meta Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api).

## Voice notes (QR and Meta)

Voice recognition uses the company's effective AI provider, endpoint and credentials, independently of the WhatsApp transport. The provider must support `POST /audio/transcriptions` with multipart audio. The default model is `whisper-1`; optional `OPENAI_TRANSCRIPTION_MODEL` / `ANYMODEL_TRANSCRIPTION_MODEL` select the speech model for the corresponding provider. They do not change the reply model. There is no fallback to another provider or another company's key. Language is detected from the recording; recognition does not translate it. API format reference: https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create.

### Diagnosing voice failures

Service administrators can open **AI Usage → AI request errors**, globally or within a company. The report shows the latest 50 failed calls in the selected period with provider, model, operation and a safe error code. It includes previously recorded failures; older `voice_provider_error` / `voice_unavailable` values lack the original HTTP status and cannot establish its cause retroactively. The report never includes provider response bodies, prompts, recordings, transcripts or credentials, and remains inaccessible to tenant administrators.

- `voice_http_400/404/405/422`: check the provider's transcription endpoint, available speech model and accepted audio format. A working chat model alone does not confirm that transcription is supported.
- `voice_http_401/403`: check the selected company's provider credential and permissions.
- `voice_http_402/429`: check provider balance and request limits.
- `voice_http_413/415`: audio size or format rejected.
- `voice_timeout`, `voice_http_408/504`: recognition exceeded the request timeout or provider deadline.
- Other `voice_http_5xx` or `voice_network_error`: provider/network failure.
- `voice_empty`: a valid text response was empty; `voice_invalid_response`: JSON or response structure was invalid.

After correcting the cause, **Return to AI** retries the stored failed voice recording. Successful transcripts are cached; do not ask the customer to resend an attachment that is already stored. A screenshot of the generic failure banner alone does not prove a provider configuration problem or successful production transcription.

Supported audio: OGG/Opus (WhatsApp voice notes), MP3, M4A/MP4 audio, WAV, FLAC and WebM audio, up to the existing 16 MiB attachment limit. AAC and AMR are retained for staff but are not converted automatically. Requests time out after 20 seconds per recording; a batch of up to five unprocessed recordings has a 55-second total recognition budget. A voice note followed immediately by text is included in the same reply context.

The original audio and caption remain unchanged. Successful transcripts are cached privately on the attachment, scoped to the tenant and conversation. No public audio URL is sent to the model. Storage access verifies the owning inbound message, the file path and actual file size. Concurrent workers share a transcription claim; retries reuse completed transcripts. A crashed, unfinished claim is handed to staff rather than automatically repeating an uncertain paid request.

Successful recognition costs one AI credit per recording (`AI_VOICE_TRANSCRIPTION`); generating a reply uses the existing one-credit `AI_MANAGER_REPLY` operation. Cached recognition and failed recognition do not consume additional credits. Both stages use the existing reservation/usage ledger. Whisper's provider cost is duration-based; until duration pricing is supported the usage report marks its cost as unavailable, not zero. A preflight check requires credits for recognition and a reply; per-call reservations also enforce concurrent quota usage.

Human takeover, pauses, working hours, AI entitlements and Meta's 24-hour window are checked before recognition, between recordings and before reply delivery. Spoken requests for a person follow the existing handoff policy. Recognition failure, unsupported media or empty output hands the conversation to staff with a translated reason, without inventing a reply.

Deploy the updated Prisma client and apply `packages/db/prisma/migrations/20261005_voice_transcription.sql` when migrations are managed externally. The normal database bootstrap applies this additive column for both PostgreSQL and PGlite. Green API's external seller transcription is unchanged.

Acceptance coverage uses mocked speech/model endpoints for both direct transports: company prompt and published knowledge, cache and two-stage credit accounting, overlapping revisions, duplicate workers, human takeover during recognition, spoken handoff requests, empty output, timeout, provider errors, tenant isolation, missing/oversized files, path traversal and unsupported audio. Actual recognition quality and provider availability require a post-deploy voice note from a test phone (Kazakh and Russian) through each connected number; no live WhatsApp or speech-provider call is made by the tests.
