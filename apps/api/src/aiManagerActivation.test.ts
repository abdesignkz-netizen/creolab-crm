import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeWhatsAppAiActivation, publishedAiFingerprints } from "./services/tenantAiConfigService.ts";

describe("WhatsApp AI activation labels", () => {
  const prompt = "Ты менеджер компании";
  const knowledge = [{ title: "FAQ", content: "Цена 10 000" }];
  const fps = publishedAiFingerprints({ tenantPrompt: prompt, knowledge });

  it("marks prompt and knowledge inactive when WhatsApp is not connected", () => {
    const result = describeWhatsAppAiActivation({ prompt, knowledge, integration: null });
    assert.equal(result.prompt.live, false);
    assert.equal(result.knowledge.live, false);
    assert.equal(result.prompt.label, "Не активен в WhatsApp");
    assert.equal(result.knowledge.label, "Не активна в WhatsApp");
    assert.match(result.prompt.reason, /не подключ/);
  });

  it("marks prompt and knowledge live when WhatsApp has the same version", () => {
    const result = describeWhatsAppAiActivation({
      prompt,
      knowledge,
      integration: {
        schemaJson: {
          aiSync: { livePromptFp: fps.promptFp, liveKnowledgeFp: fps.knowledgeFp },
        },
      },
    });
    assert.equal(result.prompt.live, true);
    assert.equal(result.knowledge.live, true);
    assert.equal(result.prompt.label, "Активен в WhatsApp");
    assert.equal(result.knowledge.label, "Активна в WhatsApp");
  });

  it("keeps knowledge live while a newer prompt is only saved in admin", () => {
    const result = describeWhatsAppAiActivation({
      prompt: "Новая версия промта",
      knowledge,
      integration: {
        schemaJson: {
          aiSync: { livePromptFp: fps.promptFp, liveKnowledgeFp: fps.knowledgeFp },
        },
      },
    });
    assert.equal(result.prompt.live, false);
    assert.equal(result.knowledge.live, true);
    assert.match(result.prompt.reason, /более новая версия/);
  });
});
