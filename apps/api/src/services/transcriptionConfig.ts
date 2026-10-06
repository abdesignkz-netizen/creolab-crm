/** Platform speech-to-text service. Never reads a company's reply model or credentials. */
export function getTranscriptionConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = (env.TRANSCRIPTION_API_KEY || "").trim();
  const model = (env.TRANSCRIPTION_MODEL || "").trim() || "whisper-1";
  const baseUrl = (env.TRANSCRIPTION_BASE_URL || "").trim().replace(/\/+$/, "") || "https://api.openai.com/v1";
  let validUrl = false, provider = "openai-compatible";
  try {
    const url = new URL(baseUrl);
    validUrl = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    if (url.origin === "https://api.openai.com") provider = "openai";
  } catch { /* Report a safe configuration error, never the configured URL or key. */ }
  const errorCode = !validUrl || model.length > 120 || /[\r\n]/.test(model) ? "voice_service_config"
    : !apiKey ? "voice_service_missing" : null;
  return { apiKey, baseUrl, model, provider, errorCode };
}

/** Safe, read-only configuration status for service administration; not a connectivity check. */
export function getTranscriptionStatus() {
  const { model, provider, errorCode } = getTranscriptionConfig();
  return { model, provider, configured: errorCode === null, errorCode };
}
