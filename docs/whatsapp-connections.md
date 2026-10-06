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

### QR reception while the customer closes BasQar

The browser only polls pairing/status endpoints. Leaving Integrations, closing the tab or signing out of the customer account does not own or terminate the server socket. The API starts the QR runtime at boot, restores encrypted credentials from PostgreSQL and discovers saved sessions every three seconds without customer requests. The pinned Baileys transport sends keepalive probes; transient closes use a bounded reconnect backoff. A normal server restart closes the socket without logging the linked device out. Revocation from WhatsApp still requires pairing again.

Continuous reception requires a continuously running API process, reachable PostgreSQL, the unchanged encryption key and outbound connectivity to WhatsApp. A suspended database or stopped server prevents it; browser polling cannot solve that. Render Free web services can sleep after idle traffic; use an always-running service for this workload. See https://render.com/docs/free#spinning-down-on-idle.

`node scripts/test-api.mjs whatsappQrBackground.test.ts whatsappConnections.test.ts` verifies timer-driven receipt with no HTTP server/browser or manual ticks, lease renewal, network reconnection, offline append delivery, restoration after process restart and explicit WhatsApp logout. These tests use a simulated WhatsApp transport; production acceptance still requires closing BasQar in all browsers and sending a real test message while the API and database are healthy.

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

Speech recognition is a separate platform service: **stored audio → transcription text → company AI manager**. It never reads the company's reply model, provider, API URL or credentials. The selected reply model (including `anymodel:cx/gpt-5.6-sol`) receives text with the published company prompt and knowledge; no audio is sent to the chat model. Language is detected from the recording, without translation.

### Local recognition (default; no OpenAI API)

The Docker image runs the pinned `abilmansplus/whisper-turbo-kaz-rus-v1` RU/KK model with **whisper.cpp v1.8.3, CPU Q5_0**. The native decoder source is pinned to commit `2eeeba56e9edd762b4b38467bab96c2517163158` and its source archive SHA256 is verified during build. Existing CTranslate2 INT8 installations remain supported. It uses open-source Whisper weights; it does **not** use the OpenAI service, SDK, API account or key. The build downloads model files from Hugging Face once. At runtime recordings stay on the BasQar host and inference is offline; only the resulting text goes to the selected company reply provider.

```dotenv
TRANSCRIPTION_ENGINE=local
TRANSCRIPTION_PYTHON=/opt/basqar-speech/venv/bin/python
TRANSCRIPTION_MODEL_PATH=/opt/basqar-speech/model
```

These defaults are baked into the API Docker image. A separate build stage merges the pinned base and RU/KK LoRA adapter, converts its safetensors weights to GGML and quantizes to Q5_0. No remote Python code, optimizer or pickle checkpoints are loaded. PyTorch/Transformers/PEFT and the compiler stay out of the runtime image. The installation contains `model.bin`, `speech-runner`, metadata and the upstream engine license; `basqar-profile.json` is written only after successful conversion. Build-time RAM/disk requirements are substantially greater than runtime. Do not change company chat models, credentials or encryption keys for this switch.

**Capacity:** the `kaz-rus-turbo-q5` profile requires **1408 MiB available RAM**, after CRM/Java/QR usage. Its model file is limited to 700 MiB. Legacy `kaz-rus-turbo` INT8 keeps its 4096 MiB threshold, `tiny` keeps 768 MiB, and unmarked small keeps 2048 MiB. Do not relabel an old/custom model to bypass these checks. The new threshold is informed by development measurements, not a Linux/Render capacity guarantee. A 2 GiB instance can pass only while other processes leave the required headroom; verify real Render metrics. The code does not change a paid hosting plan. A watchdog checks capacity every 100 ms and terminates the native decoder if free headroom falls below 128 MiB; this reduces risk but cannot guarantee protection against sudden OOM. Unknown capacity fails closed at startup. Process memory and container file cache both affect Linux cgroup usage.

Only one recognition process runs per host, including API/worker processes sharing `/tmp`. Other jobs retry through the existing outbox. The short-lived process releases its model memory on completion; two CPU threads and reduced process priority limit contention. The Python wrapper streams bounded float32 PCM to the native decoder without a temporary audio file. Cancellation kills the entire process group; Linux parent-death handling also stops an orphan native process. The native decoder has a 60-second deadline within the existing 65-second outer timeout. Audio travels over stdin; no temporary recording is created. Neither decoder process inherits application credentials, accepts only audio container formats and prohibits file/network URL protocols in playlists. Invalid audio and decode limits do not reach the reply model.

Service administrators see the local engine under **Service settings → Voice message transcription**. Configuration presence does not prove sufficient runtime capacity or recognition quality. Check **AI Usage → AI request errors** after a test message. A failed stored recording can be retried with **Return to AI** after fixing deployment resources. No database migration or new provider key is needed for this switch.

An optional external compatible transcription adapter is retained only for explicit `TRANSCRIPTION_ENGINE=http` configuration, with its own `TRANSCRIPTION_API_KEY`, HTTPS `TRANSCRIPTION_BASE_URL` and `TRANSCRIPTION_MODEL`. There is no default external endpoint, and no fallback to any company's chat credentials or model.

Local voice language selection is restricted to Russian (`ru`) and Kazakh (`kk`): the worker compares only those detection probabilities and explicitly passes the selected language to transcription (never translation). The shared AI Manager prompt requires RU/KK replies, following the customer's understandable messages rather than a foreign-language historical AI reply. A script sanity check blocks predominantly foreign-script transcripts/replies, including Polish, while allowing Latin brands and URLs inside Cyrillic prose. This check is not a full language classifier and cannot establish recognition accuracy. Invalid cached transcripts are not reused or automatically re-billed; direct-channel voice replies failing the check ask for clarification in RU/KK without pausing AI; other replies still use the existing handoff policy. Existing remote Green API prompt copies require their normal synchronization to receive the updated shared policy.

Engine documentation: https://github.com/ggml-org/whisper.cpp (Q5) and https://github.com/SYSTRAN/faster-whisper (legacy INT8). Bundled model: https://huggingface.co/abilmansplus/whisper-turbo-kaz-rus-v1 (base and adapter revisions pinned in `scripts/install-speech-model.py`). Its author reports Kazakh/Russian benchmark results; these do not guarantee accuracy on WhatsApp voice notes. Both languages, accents, background noise and mixed speech require deployment evaluation.

### Diagnosing voice failures

Service administrators can open **AI Usage → AI request errors**, globally or within a company. The report shows the latest 50 failed calls in the selected period with provider, model, operation and a safe error code. It includes previously recorded failures; older `voice_provider_error` / `voice_unavailable` values lack the original HTTP status and cannot establish its cause retroactively. The report never includes provider response bodies, prompts, recordings, transcripts or credentials, and remains inaccessible to tenant administrators.

- `voice_http_400/404/405/422`: check the provider's transcription endpoint, available speech model and accepted audio format. A working chat model alone does not confirm that transcription is supported.
- `voice_local_missing`: redeploy the Docker image containing Python, the speech engine and model files; check the configured paths on every worker.
- `voice_resources`: fewer than 1408 MiB of available memory for RU/KK Q5, or the runtime watchdog detected less than 128 MiB (legacy INT8 Turbo requires 4096 MiB; tiny 768 MiB; small 2048 MiB), or capacity cannot be read. Check the actual Render instance resources; this is unrelated to the company reply model or API key.
- `voice_local_failed`: local decoder/model process failed; inspect server resource metrics and deployment dependencies. Raw decoder output is not exposed or logged.
- `voice_too_long`: decoded audio exceeds two minutes.
- `voice_pending`: another local worker is busy; the outbox retries automatically without switching the conversation to a manager.
- `voice_service_missing` / `voice_service_config`: invalid engine or incomplete explicitly selected external speech service configuration.
- `voice_http_401/403`: check the independent speech service key and permissions.
- `voice_http_402/429`: check provider balance and request limits.
- `voice_http_413/415`: audio size or format rejected.
- `voice_timeout`, `voice_http_408/504`: recognition exceeded the request timeout or provider deadline.
- Other `voice_http_5xx` or `voice_network_error`: provider/network failure.
- `voice_empty`: a valid text response was empty; `voice_invalid_response`: JSON or response structure was invalid.

After correcting the cause, stored audio remains available for an explicit transcription retry. New failures no longer pause the conversation: subsequent customer messages are processed normally. **Return to AI** remains for conversations already handed to staff; it is not required after a new speech failure. Successful transcripts are cached. A screenshot of the generic failure banner alone does not prove a provider configuration problem or successful production transcription.

Supported audio: OGG/Opus (WhatsApp voice notes), MP3, M4A/MP4 audio, WAV, FLAC and WebM audio, up to the existing 16 MiB attachment limit. AAC and AMR are retained for staff but are not converted automatically. Local recordings are limited to two minutes of decoded audio, 65 seconds of execution per recording and a 75-second batch budget (up to five pending recordings). Optional HTTP recognition keeps its 20-second per-recording / 55-second batch budget. Execution deadlines also cover model loading and decoding; slower servers may time out before these duration limits. A voice note followed immediately by text is included in the same reply context.

The original audio and caption remain unchanged. Successful transcripts are cached privately on the attachment, scoped to the tenant and conversation. No public audio URL is sent to the model. Storage access verifies the owning inbound message, the file path and actual file size. Concurrent workers share a transcription claim; retries reuse completed transcripts. A crashed, unfinished speech claim is not automatically repeated or re-billed; the customer is asked for clarification while AI remains active.

Successful recognition costs one AI credit per recording (`AI_VOICE_TRANSCRIPTION`); generating a reply uses the existing one-credit `AI_MANAGER_REPLY` operation. Cached recognition and failed recognition do not consume additional credits. Both stages use the existing reservation/usage ledger. Local inference has no external speech API charge, but consumes hosting resources. Its usage entry is labelled `local / whisper-turbo-kaz-rus-v1-q5` (older installations retain their original label); unknown infrastructure cost remains unavailable rather than invented. A preflight check requires credits for recognition and a reply; per-call reservations also enforce concurrent quota usage.

Human takeover, pauses, working hours, AI entitlements and Meta's 24-hour window are checked before recognition, between recordings and before reply delivery. Spoken requests for a person follow the existing handoff policy. Recognition failure, unsupported audio or empty output produces a fixed RU/KK request to repeat the recording or write text. AI remains active; failed older recordings do not block later text or audio. The speech error is retained in the usage record where a call occurred and on the outbound operation. The clarification uses the existing idempotency, revision, takeover and channel checks. Explicit requests for a human and company/channel restrictions still retain their handoff behavior. An unclear transcript should prompt a clarifying question, not LOW_CONFIDENCE handoff merely because the audio was unclear. This does not establish Kazakh recognition accuracy: the installed model must be evaluated using real customer recordings.

Deploy the updated Prisma client and apply `packages/db/prisma/migrations/20261005_voice_transcription.sql` when migrations are managed externally. The normal database bootstrap applies this additive column for both PostgreSQL and PGlite. Green API's external seller transcription is unchanged.

Acceptance coverage uses distinct mocked speech/model endpoints and keys for both direct transports: independence from AnyModel/OpenAI reply model selection, missing speech configuration without credential fallback, company prompt and published knowledge, cache and two-stage credit accounting, overlapping revisions, duplicate workers, human takeover during recognition, spoken handoff requests, empty output, timeout, provider errors, tenant isolation, missing/oversized files, path traversal and unsupported audio. Actual recognition quality and provider availability require a post-deploy voice note from a test phone (Kazakh and Russian) through each connected number; no live WhatsApp or speech-provider call is made by the tests.

Local regression checks: `node --experimental-strip-types --test apps/api/src/localTranscription.test.ts`, `node scripts/test-api.mjs whatsappConnections.test.ts`, and (with `scripts/speech-requirements.txt` installed) `python scripts/test-local-transcription.py`. The process tests use protocol fixtures; they verify isolation, cancellation, bounds and error handling, not linguistic quality. Test real Kazakh and Russian voice notes after deployment before treating production recognition as verified.

A separate real-engine smoke check on 2026-10-06 used a locally synthesized Russian sentence encoded to OGG/Opus. The then-bundled small/int8 engine transcribed the complete sentence with its meaning preserved in 7.49 seconds on the development Mac. This was not a Render performance test or a live WhatsApp/Kazakh recognition test. Docker/Render deployment still needs verification on the actual host.

The previous lightweight Tiny model prioritizes memory and speed over recognition accuracy. In a development-Mac comparison on the same Russian OGG/Opus sentence, tiny/int8 used 400.3 MiB peak RSS and 1.49 seconds versus small/int8 at 786.0 MiB and 5.51 seconds. Tiny preserved the basic request but introduced word-ending errors; small reproduced the sentence correctly. These are one synthetic sentence and macOS process measurements, not Linux/Render capacity guarantees or a Kazakh-quality evaluation. A follow-up using the same sentence repeated to 113.3 seconds took 33.51 seconds with 577.5 MiB peak RSS for tiny/int8. The 768 MiB guard exceeds both measured peaks; it is not a substitute for testing on the target host. Validate real Russian/Kazakh recordings after deployment.

### Installing the RU/KK model

The API Dockerfile builds and installs RU/KK Turbo Q5 by default. The following legacy local command still builds INT8; Q5 additionally requires the pinned native build shown below. For a local build, create a separate Python 3.11+ environment, install CPU PyTorch 2.9.1 and `scripts/speech-build-requirements.txt`, then run:

```sh
python scripts/install-speech-model.py data/speech/kaz-rus-turbo
```

Use an empty target directory. The installer refuses to overwrite an active installation. Weights under `data/speech/` are ignored by Git. Set `TRANSCRIPTION_MODEL_PATH` to the absolute resulting directory on that host; retain the existing faster-whisper runtime Python and `TRANSCRIPTION_ENGINE=local`. Restart the API after changing the path. A fresh Docker image uses `/opt/basqar-speech/model` automatically. Do not point Render at a developer machine's path. No paid plan is changed automatically. Runtime remains offline; only build downloads require internet. Existing execution deadlines and memory protection remain active; long recordings on slow CPUs can time out.

For a repeatable offline smoke check (on a development host with enough RAM), run:

```sh
python scripts/evaluate-speech.py data/speech/kaz-rus-turbo /path/to/recording.ogg --reference /path/to/reference.txt
```

The tool prints the transcript, runtime, peak process RSS and a simple normalized word error rate if a reference is supplied. It deliberately bypasses the Linux-only production memory guard; it does not send audio to a service. Test multiple Russian and Kazakh speakers plus mixed-language notes before accepting production quality. `BASQAR_SPEECH_BUILD_CACHE` may point to a build-only download directory to resume source downloads; it is not a runtime setting.

Local installation and real-engine smoke checks completed on 2026-10-06 (development Mac, CPU INT8, two threads). The installed `data/speech/kaz-rus-turbo/model.bin` is approximately 782 MiB. The API configuration reader recognizes it as `whisper-turbo-kaz-rus-v1-int8` without a configuration error.

| Recording | Result | Time including loading | Peak process RSS |
| --- | --- | --- | --- |
| Kazakh FLEURS `kk_kz`, test row 0 / id 1788, 14.88 seconds | One word substitution in 21 normalized words: `хатын` became `ханын`; WER 4.76% | 22.04 s | 1474.2 MiB |
| Russian synthetic OGG/Opus request for pricing and a consultation | All words matched the source sentence, ignoring punctuation/case | 20.02 s | 1472.2 MiB |

The same Kazakh recording produced heavily distorted text with Tiny (WER 114.29%, 9.66 s, 506.9 MiB). WER can exceed 100% when there are inserted words. Kazakh sample attribution: [Google FLEURS](https://huggingface.co/datasets/google/fleurs), CC-BY-4.0, retrieved through [the mteb/fleurs copy](https://huggingface.co/datasets/mteb/fleurs). This is a single public read-speech sample and one synthesized Russian sentence, not a representative benchmark or an error-free recognition guarantee. No customer audio was used. Docker/Render and live WhatsApp were not exercised. The 4 GiB free-memory guard remains conservative; measured Mac RSS is not the total RAM requirement for CRM/Java/QR or a Linux capacity guarantee. A 512 MiB Render instance cannot run this model.


### Building the compact Q5 decoder

Use the source revision and checksum from `apps/api/Dockerfile`. With that whisper.cpp source unpacked locally:

```sh
cmake -S scripts/speech-cpp -B /tmp/basqar-native-build -DWHISPER_SOURCE_DIR=/absolute/path/to/whisper.cpp -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/basqar-native-build --target basqar-speech whisper-quantize -j 2
BASQAR_WHISPER_CPP_SOURCE=/absolute/path/to/whisper.cpp BASQAR_SPEECH_RUNNER=/tmp/basqar-native-build/basqar-speech BASQAR_SPEECH_QUANTIZER=/tmp/basqar-native-build/bin/whisper-quantize python scripts/install-speech-model.py data/speech/kaz-rus-turbo-q5 kaz-rus-turbo-q5
```

The Python invocation uses the separate build environment described above. Install into an empty directory. `TRANSCRIPTION_ENGINE=local` and the existing Docker model path remain unchanged. `getTranscriptionStatus` distinguishes Q5 from INT8 and rejects a missing native executable. `evaluate-speech.py` reports parent and child peak RSS and their sum as a conservative upper bound, since peaks need not occur simultaneously.

Initial Q5 prototype measurements on the development Mac on 2026-10-06, before pause-based segmentation, with automatic RU/KK selection: Kazakh FLEURS sample 26.19 seconds, parent 48.6 MiB + decoder 885.1 MiB = 933.7 MiB combined peak upper bound, WER 4.76% (same word substitution as INT8). Russian synthesized request: 23.79 seconds, 863.8 MiB combined; the initial word had a spelling error (`сдравствуйте`), remaining words preserved. A 46.64-second synthetic sequence made by repeating the Kazakh sample three times used 952.9 MiB combined and took 44.6 seconds, but contained omissions and repetitions. It is a memory stress test, not evidence of acceptable long-recording accuracy. No zero-error or realtime guarantee is made. Actual Render x86 CPU performance, memory under CRM load, Docker build and WhatsApp end-to-end delivery still require deployment verification. Keep the 60/65-second deadlines; slow/long requests can time out without pausing AI. No paid plan is upgraded automatically.


The final native path first uses the bundled Silero VAD to split at pauses into bounded speech spans (25-second target, 500 ms padding, preserving short recording edges), then processes those spans sequentially in one native model instance. Language selection compares RU/KK probabilities from the longest span; recognition does not translate. This avoids relying on generated timestamps to advance through a long recording. Pure silence is rejected before loading the native model. The framed stdin protocol bounds chunk count, total samples, finite PCM values and output length; Docker build executes the native protocol tests.

Final pause-based long-sample check: the same 46.64-second repeated Kazakh recording completed in 51.81 seconds with 101.9 MiB wrapper peak plus 904.3 MiB decoder peak (1006.2 MiB combined upper bound). All three clauses were retained; one opening abbreviation was omitted and `хатын` was once decoded as `ханын`. This is still imperfect recognition. The shorter pre-padding VAD checks used 963.2 MiB combined for Kazakh and 962.0 MiB for Russian. These local measurements support the 1408 MiB startup budget, but do not verify the 2 GiB Render deployment. At 2048 MiB total, other container usage must leave that budget available (roughly 640 MiB or less already used); runtime memory pressure can still stop recognition. On a slower 1-CPU server longer recordings may exceed the execution deadline. Do not claim production readiness from the configuration marker alone.
