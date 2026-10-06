import assert from "node:assert/strict";
import { test } from "node:test";
import { hasSupportedAiScript } from "./services/aiLanguagePolicy.ts";
import { voiceTranscript } from "./services/voiceTranscriptionService.ts";

test("voice and reply script guard accepts RU/KK with brands and rejects foreign prose", () => {
  for (const text of ["Здравствуйте! Чем помочь?", "Сәлеметсіз бе! Қандай көмек қажет?", "BasQar арқылы WhatsApp хабарламаларын өңдей аласыз.", "Откройте https://bsqr.kz/sign/document или напишите info@creolab.kz."]) {
    assert.ok(hasSupportedAiScript(text), text);
    assert.equal(voiceTranscript({ status: "done", text }), text);
  }
  for (const text of ["Nie jestem pewien, czy dobrze zrozumiałem wiadomość głosową.", "Please clarify what you need.", "こんにちは", "", "123"]) {
    assert.equal(hasSupportedAiScript(text), false);
    assert.equal(voiceTranscript({ status: "done", text }), "");
  }
});
