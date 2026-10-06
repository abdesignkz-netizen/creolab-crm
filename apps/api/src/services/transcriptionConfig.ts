import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Local by default. An external service requires an explicit opt-in and its own settings. */
export function getTranscriptionConfig(env: NodeJS.ProcessEnv = process.env) {
  const engine = (env.TRANSCRIPTION_ENGINE || "local").trim();
  const python = env.TRANSCRIPTION_PYTHON || "/opt/basqar-speech/venv/bin/python";
  const modelPath = env.TRANSCRIPTION_MODEL_PATH || "/opt/basqar-speech/model";
  if (engine !== "http") {
    let errorCode = engine !== "local" ? "voice_service_config"
      : !existsSync(python) || !["model.bin", "config.json", "tokenizer.json"].every(file => existsSync(join(modelPath, file))) ? "voice_local_missing" : null;
    let model = "faster-whisper-small-int8", requiredAvailableMiB = 2048;
    if (!errorCode && existsSync(join(modelPath, "basqar-profile.json"))) {
      try {
        const profile = JSON.parse(readFileSync(join(modelPath, "basqar-profile.json"), "utf8"));
        const bytes = statSync(join(modelPath, "model.bin")).size;
        if (profile?.profile !== "tiny" || Object.keys(profile).length !== 1 || bytes <= 0 || bytes > 100 * 1024 ** 2) throw new Error("Invalid profile");
        model = "faster-whisper-tiny-int8"; requiredAvailableMiB = 768;
      } catch { errorCode = "voice_service_config"; }
    }
    return { engine: "local" as const, python, modelPath, model, requiredAvailableMiB, provider: "local", apiKey: "", baseUrl: "", errorCode };
  }
  const apiKey = (env.TRANSCRIPTION_API_KEY || "").trim();
  const model = (env.TRANSCRIPTION_MODEL || "").trim();
  const baseUrl = (env.TRANSCRIPTION_BASE_URL || "").trim().replace(/\/+$/, "");
  let validUrl = false, provider = "openai-compatible";
  try {
    const url = new URL(baseUrl);
    validUrl = url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    if (url.origin === "https://api.openai.com") provider = "openai";
  } catch { /* Report a safe configuration error, never the configured URL or key. */ }
  const errorCode = !validUrl || !model || model.length > 120 || /[\r\n]/.test(model) ? "voice_service_config"
    : !apiKey ? "voice_service_missing" : null;
  return { engine: "http" as const, python, modelPath, apiKey, baseUrl, model, provider, errorCode };
}

/** Safe, read-only configuration status for service administration; not a connectivity check. */
export function getTranscriptionStatus() {
  const config = getTranscriptionConfig();
  const { engine, model, provider, errorCode } = config;
  return { engine, model, provider, configured: errorCode === null, errorCode,
    ...(engine === "local" ? { requiredAvailableMiB: config.requiredAvailableMiB } : {}) };
}
