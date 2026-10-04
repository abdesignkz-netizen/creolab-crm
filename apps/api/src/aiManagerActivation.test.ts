import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeWhatsAppAiActivation, publishedAiFingerprints } from "./services/tenantAiConfigService.ts";

describe("WhatsApp AI activation labels", () => {
  const prompt = "Ты менеджер компании";
  const knowledge = [{ title: "FAQ", content: "Цена 10 000" }];
  const fps = publishedAiFingerprints({ tenantPrompt: prompt, knowledge });

  it("shows published settings active for enabled QR and Meta without seller synchronization", () => {
    for (const type of ["whatsapp_qr", "whatsapp_cloud"]) {
      const integration = { type, status: "active", channelConnections: [{ status: "active", autoReply: true }] };
      const live = describeWhatsAppAiActivation({ prompt, knowledge, integration, enabled: true });
      assert.equal(live.prompt.live, true); assert.equal(live.knowledge.live, true); assert.equal(live.syncedAt, null);
      assert.equal(describeWhatsAppAiActivation({ prompt, knowledge, integration, enabled: false }).prompt.live, false);
      integration.channelConnections[0].autoReply = false;
      assert.equal(describeWhatsAppAiActivation({ prompt, knowledge, integration }).prompt.live, false);
    }
  });

  it("does not present a saved opt-in as live while the model is unconfigured", () => {
    for (const type of ["whatsapp_qr", "whatsapp_cloud"]) {
      const result = describeWhatsAppAiActivation({ prompt, knowledge, enabled: true,
        integration: { type, status: "active", channelConnections: [{ status: "active", autoReply: true }] },
        unavailableReason: "ai_model_missing" });
      assert.equal(result.prompt.ready, true);
      assert.equal(result.knowledge.ready, true);
      assert.equal(result.prompt.live, false);
      assert.equal(result.knowledge.live, false);
      assert.match(result.prompt.reason, /модели ИИ/);
    }
  });

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
