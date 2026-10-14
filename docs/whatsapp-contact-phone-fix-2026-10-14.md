# WhatsApp phone synchronization — 14 October 2026

## Observed issue

The CREOLAB WhatsApp conversation displayed “Нет телефона”. Its client card also had no saved phone method and incorrectly disabled “Написать”, despite an existing QR conversation. The earlier long numeric transport identifier was a WhatsApp LID, not evidence of a phone number.

Incoming messages already looked up WhatsApp's LID-to-phone mapping, but separate `lid-mapping.update` and contact upsert/update events were not applied to CRM contacts. Existing conversations were only enriched by a later inbound message.

## Correction

- Apply phone mappings and contact updates to an existing contact in the same WhatsApp connection. Do not import unrelated contacts or merge conflicting identities.
- Restore missing phone methods from the persisted Signal mapping store after connection/restart, in bounded batches; recheck for late mappings every five minutes. This does not send customer messages or query arbitrary numbers.
- Serialize phone insertion to avoid duplicate methods, preserving manually selected primary numbers. Never interpret an opaque LID as a phone.
- Recognize QR/Cloud conversations on the client card so “Написать” opens the existing conversation even without a phone method.
- Show “Номер ещё не получен из WhatsApp” instead of asserting the client has no phone. Display a real phone as soon as it is available. Label QR/Cloud conversations as WhatsApp.

## Verification

- Isolated API suites: contact (15), contactLabels (3), WhatsApp connections (52) passed. Coverage includes delayed mappings without new inbound messages, repeated events, contact upserts/updates, primary phone preservation, conflicting identities, connection isolation, restart recovery, and sending via a LID.
- Web: 38 tests, API/web type checks, and production web build passed. Existing Vite chunk-size warning remains.
- Local browser: client card opens the correct QR conversation through “Написать”; the composer is focused and the send button enables after entering text. Test text was cleared without sending.
- No schema migration, AI control change, customer message or manual production contact edit is required.

An actual phone cannot be reconstructed from a LID if WhatsApp has not supplied a mapping. Live recovery must be verified after deployment; passing tests alone does not establish that this specific contact's number is available.
