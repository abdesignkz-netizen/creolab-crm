import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectSituationFacts,
  enrichSituationSummary,
  isWaitingManagementText,
} from "./services/conversationContextService.ts";
import type { ConversationAnalysis } from "./services/conversationContextTypes.ts";

function empty(): ConversationAnalysis {
  return {
    clientIntent: null,
    detectedNeed: "Презентация создаётся с нуля",
    suggestedRequestStatus: null,
    suggestedDealStage: null,
    waitingFor: "MANAGER",
    needsReply: true,
    agreements: [],
    suggestedTasks: [],
    suggestedNextAction: "Ответить клиенту",
    humanRequired: false,
    humanReason: null,
    summaryUpdate: null,
    evidenceMessageIds: [],
    confidence: "LOW",
    facts: {},
  };
}

describe("conversation situation facts", () => {
  it("sees sent commercial proposal and waiting for client management", () => {
    const now = new Date("2026-09-18T10:00:00Z");
    const messages = [
      {
        senderKind: "client",
        direction: "inbound",
        text: "Нужна презентация с нуля",
        createdAt: now,
      },
      {
        senderKind: "staff",
        direction: "outbound",
        text: "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ",
        attachments: [{ fileName: "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ.pdf", documentType: "document" }],
        createdAt: new Date("2026-09-18T10:10:00Z"),
      },
      {
        senderKind: "client",
        direction: "inbound",
        text: "Добрый день! Я направила руководству, они решают кого нанять",
        createdAt: new Date("2026-09-18T10:20:00Z"),
      },
      {
        senderKind: "staff",
        direction: "outbound",
        text: "Эльвира, добрый день! Хотели уточнить интересно ли наше предложение?",
        createdAt: new Date("2026-09-18T10:30:00Z"),
      },
    ];
    const facts = detectSituationFacts(messages);
    assert.equal(facts.proposalSent, true);
    assert.equal(facts.waitingForManagement, true);

    const analysis = empty();
    enrichSituationSummary(analysis, messages);
    assert.match(analysis.summaryUpdate || "", /КП выслано/);
    assert.match(analysis.summaryUpdate || "", /руководства клиента/);
    assert.doesNotMatch(analysis.summaryUpdate || "", /Явных договорённостей пока нет/);
    assert.equal(analysis.waitingFor, "CLIENT");
    assert.equal(analysis.needsReply, false);
    assert.equal(analysis.suggestedNextAction, "Дождаться решения руководства");
    assert.equal(analysis.suggestedDealStage, "proposal_sent");
  });

  it("recognizes sent prices without a KP filename", () => {
    const analysis = empty();
    enrichSituationSummary(analysis, [
      {
        senderKind: "staff",
        direction: "outbound",
        text: "Стоимость презентации: 180 000 тг, срок 10 дней",
      },
      {
        senderKind: "client",
        direction: "inbound",
        text: "Передала директору на согласование",
      },
    ]);
    assert.match(analysis.summaryUpdate || "", /Цены отправлены/);
    assert.match(analysis.summaryUpdate || "", /руководства клиента/);
    assert.equal(analysis.waitingFor, "CLIENT");
  });

  it("recognizes management hold phrasing", () => {
    assert.equal(isWaitingManagementText("я направила руководству, они решают кого нанять"), true);
    assert.equal(isWaitingManagementText("передала директору на согласование"), true);
    assert.equal(isWaitingManagementText("нужна презентация"), false);
  });

  it("adds missing offer facts into an already generic summary", () => {
    const analysis = empty();
    analysis.summaryUpdate = "Потребность: Презентация создаётся с нуля. Клиент ждёт ответа. Явных договорённостей пока нет.";
    enrichSituationSummary(analysis, [
      {
        senderKind: "staff",
        direction: "outbound",
        text: "",
        attachments: [{ originalFileName: "КП Creolab.pdf" }],
      },
      {
        senderKind: "client",
        direction: "inbound",
        text: "Отправила руководству, ждут решения",
      },
    ]);
    assert.match(analysis.summaryUpdate || "", /КП выслано/);
    assert.match(analysis.summaryUpdate || "", /руководства клиента/);
    assert.doesNotMatch(analysis.summaryUpdate || "", /Явных договорённостей пока нет/);
    assert.doesNotMatch(analysis.summaryUpdate || "", /Клиент ждёт ответа/);
  });
});
