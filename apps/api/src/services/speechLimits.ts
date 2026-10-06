// CPU speech recognition runs in the durable background job, not an HTTP request.
// Keep claims alive through the batch plus reply generation/delivery preparation.
export const LOCAL_SPEECH_TIMEOUT_MS = 330_000;
export const LOCAL_SPEECH_BATCH_MS = 360_000;
export const SPEECH_CLAIM_TTL_MS = 420_000;
