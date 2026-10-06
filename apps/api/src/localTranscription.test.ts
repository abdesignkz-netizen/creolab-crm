import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { transcribeLocally } from "./services/localTranscription.ts";

test("local speech process isolates secrets, bounds output, handles failures and cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "basqar-speech-process-"));
  const python = join(dir, "fake-worker");
  const run = (signal = AbortSignal.timeout(3000)) => transcribeLocally(Buffer.from("audio bytes"), { python, modelPath: dir, signal });
  const script = async (body: string) => writeFile(python, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  const previous = process.env.SECRET_SPEECH_TEST;
  process.env.SECRET_SPEECH_TEST = "must-not-reach-decoder";
  try {
    await script('test -z "$SECRET_SPEECH_TEST" || exit 1\ntest "$HF_HUB_OFFLINE" = 1 || exit 1\ncat >/dev/null\nprintf \'{"text":"Сәлеметсіз бе!"}\'');
    assert.equal(await run(), "Сәлеметсіз бе!");
    for (const code of ["voice_local_failed", "voice_resources", "voice_pending", "voice_too_long", "voice_empty"]) {
      await script(`printf '{"error":"${code}"}'`);
      await assert.rejects(run, (error: any) => error.code === code);
    }
    await script("printf 'PRIVATE CRASH DETAIL'\nexit 1");
    await assert.rejects(run, (error: any) => error.code === "voice_local_failed" && !error.message.includes("PRIVATE"));
    await script("head -c 70000 /dev/zero");
    await assert.rejects(run, (error: any) => error.code === "voice_invalid_response");
    await script("exec sleep 60");
    await assert.rejects(() => run(AbortSignal.timeout(50)), (error: any) => error.code === "voice_timeout");
    if (process.platform !== "win32") {
      const marker = join(dir, "orphan-survived");
      await script(`(sleep 0.4; printf orphan > '${marker}') &\nwait`);
      await assert.rejects(() => run(AbortSignal.timeout(100)), (error: any) => error.code === "voice_timeout");
      await delay(500);
      assert.equal(existsSync(marker), false, "Cancellation must kill the native decoder's process group");
    }
    await rm(python);
    await assert.rejects(run, (error: any) => error.code === "voice_local_missing");
  } finally {
    if (previous === undefined) delete process.env.SECRET_SPEECH_TEST; else process.env.SECRET_SPEECH_TEST = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
