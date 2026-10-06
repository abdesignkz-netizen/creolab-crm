import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApiError } from "../errors.ts";

const worker = fileURLToPath(new URL("../../../../scripts/local-transcription.py", import.meta.url));
const safeErrors = new Set(["voice_service_config", "voice_local_missing", "voice_local_failed", "voice_resources", "voice_pending", "voice_too_long", "voice_unsupported", "voice_empty"]);
const fail = (code: string) => new ApiError(422, code, "Не удалось распознать голосовое сообщение");

/** One short-lived process per recording. No shell, public media URL or inherited API credentials. */
export async function transcribeLocally(bytes: Buffer, options: { python: string; modelPath: string; signal: AbortSignal }) {
  options.signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    let output = "", errorCode = "", aborted = false;
    const child = spawn(options.python, [worker, options.modelPath], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", PYTHONUNBUFFERED: "1",
        HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", OMP_NUM_THREADS: "2", OPENBLAS_NUM_THREADS: "2" },
    });
    const abort = () => { aborted = true; child.kill("SIGKILL"); };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 65536) { errorCode = "voice_invalid_response"; child.kill("SIGKILL"); }
      else output += chunk.toString("utf8");
    });
    child.once("error", () => { errorCode = "voice_local_missing"; });
    // A decoder may reject input and close stdin before all bytes are written.
    child.stdin.on("error", () => {});
    child.once("close", (code) => {
      options.signal.removeEventListener("abort", abort);
      if (aborted) { reject(fail("voice_timeout")); return; }
      if (errorCode) { reject(fail(errorCode)); return; }
      try {
        const result = JSON.parse(output);
        if (safeErrors.has(result?.error)) { reject(fail(result.error)); return; }
        if (code !== 0) { reject(fail("voice_local_failed")); return; }
        if (typeof result?.text !== "string" || result.text.length > 12000) { reject(fail("voice_invalid_response")); return; }
        const text = result.text.trim();
        if (!text) { reject(fail("voice_empty")); return; }
        resolve(text);
      } catch { reject(fail("voice_local_failed")); }
    });
    child.stdin.end(bytes);
  });
}
