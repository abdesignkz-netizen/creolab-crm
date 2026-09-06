import type { PrismaClient } from "@creolab/db";
import { refineResultNextActionWithLlm } from "./llmClient.ts";

export const MEETING_RESULTS = [
  "agreed",
  "needs_estimate",
  "send_proposal",
  "send_contract",
  "client_thinking",
  "callback_later",
  "reschedule",
  "refused",
  "other",
] as const;

export const MEETING_RESULT_LABEL: Record<(typeof MEETING_RESULTS)[number], string> = {
  agreed: "Договорились",
  needs_estimate: "Нужен расчёт",
  send_proposal: "Отправить КП",
  send_contract: "Отправить договор",
  client_thinking: "Клиент думает",
  callback_later: "Перезвонить",
  reschedule: "Перенести встречу",
  refused: "Отказ",
  other: "Другое",
};

export type ResultNextSuggestion = {
  type: string;
  title: string;
  dueAt?: string | null;
  dueOffsetHours?: number | null;
  purpose?: string | null;
  suggestedDealStage?: string | null;
  suggestedRequestStatus?: string | null;
  requiresConfirm: boolean;
  reason: string;
};

function ruleSuggestFromResult(input: {
  taskType: string;
  resultCode: string;
  resultText?: string | null;
}): ResultNextSuggestion[] {
  const text = String(input.resultText || "").toLowerCase();
  const code = input.resultCode;
  const out: ResultNextSuggestion[] = [];

  const push = (s: Omit<ResultNextSuggestion, "requiresConfirm"> & { requiresConfirm?: boolean }) => {
    out.push({ ...s, requiresConfirm: s.requiresConfirm !== false });
  };

  if (input.taskType === "meeting" || input.taskType === "call") {
    if (code === "send_proposal" || /кп|коммерческ|proposal/.test(text)) {
      push({
        type: "proposal",
        title: /финальн/.test(text) ? "Отправить финальное КП" : "Отправить КП",
        dueOffsetHours: /завтра|до обеда/.test(text) ? 20 : 4,
        purpose: "По результату встречи/звонка",
        suggestedDealStage: "proposal_sent",
        reason: "Клиент попросил или выбран результат «Отправить КП»",
      });
    }
    if (code === "send_contract" || /договор|контракт/.test(text)) {
      push({
        type: "send_documents",
        title: "Отправить договор",
        dueOffsetHours: /сегодня/.test(text) ? 2 : 24,
        purpose: "Подготовить и отправить договор",
        suggestedDealStage: "contract",
        reason: "Клиент попросил договор — требуется подтверждение перед отправкой",
        requiresConfirm: true,
      });
    }
    if (code === "needs_estimate" || /расч[её]т|смет/.test(text)) {
      push({
        type: "prepare_estimate",
        title: "Подготовить расчёт",
        dueOffsetHours: 24,
        purpose: "Подготовить расчёт по итогам разговора",
        reason: "Нужен расчёт",
      });
    }
    if (code === "client_thinking" || /думает|подумает|напишу сам/.test(text)) {
      push({
        type: "wait_client",
        title: "Ждать решения клиента",
        dueOffsetHours: 72,
        purpose: "Клиент думает",
        reason: "Ждём клиента",
      });
    }
    if (code === "callback_later" || /перезвон|связаться/.test(text)) {
      push({
        type: "call",
        title: "Перезвонить",
        dueOffsetHours: 24,
        purpose: "Follow-up после разговора",
        reason: "Нужен повторный звонок",
      });
    }
    if (code === "reschedule" || /перенес/.test(text)) {
      push({
        type: "meeting",
        title: "Перенести встречу / уточнить время",
        dueOffsetHours: 4,
        purpose: "Согласовать новое время",
        reason: "Встречу нужно перенести",
      });
    }
    if (code === "refused" || /отказ|не интерес/.test(text)) {
      push({
        type: "other",
        title: "Зафиксировать отказ и закрыть сделку",
        dueOffsetHours: null,
        purpose: "Отказ — статус сделки требует ручного подтверждения",
        suggestedDealStage: null,
        reason: "Отказ не применяется автоматически к WON/LOST",
        requiresConfirm: true,
      });
    }
    if (code === "agreed" && !out.length) {
      push({
        type: "follow_up",
        title: "Зафиксировать следующие шаги",
        dueOffsetHours: 24,
        purpose: "Договорились — уточнить next action",
        suggestedDealStage: "negotiation",
        reason: "Договорились, нужен конкретный следующий шаг",
      });
    }
  }

  if (!out.length) {
    push({
      type: "follow_up",
      title: "Напомнить завтра",
      dueOffsetHours: 24,
      reason: "Базовый follow-up",
    });
  }

  return out;
}

export async function analyzeTaskResultNextActions(input: {
  taskType: string;
  resultCode: string;
  resultText?: string | null;
  contactName?: string | null;
  inquiryTitle?: string | null;
}): Promise<{ suggestions: ResultNextSuggestion[]; source: "rules" | "llm+rules" }> {
  const rules = ruleSuggestFromResult(input);
  const llm = await refineResultNextActionWithLlm({
    taskType: input.taskType,
    resultCode: input.resultCode,
    resultText: input.resultText || null,
    contactName: input.contactName || null,
    inquiryTitle: input.inquiryTitle || null,
    draft: rules,
  });
  if (llm?.suggestions?.length) {
    return {
      suggestions: llm.suggestions.map((s) => ({
        type: String(s.type || "follow_up"),
        title: String(s.title || "Следующий шаг"),
        dueAt: s.dueAt || null,
        dueOffsetHours: typeof s.dueOffsetHours === "number" ? s.dueOffsetHours : null,
        purpose: s.purpose || null,
        suggestedDealStage: s.suggestedDealStage || null,
        suggestedRequestStatus: s.suggestedRequestStatus || null,
        requiresConfirm: s.requiresConfirm !== false,
        reason: s.reason || "AI предложил следующий шаг",
      })),
      source: "llm+rules",
    };
  }
  return { suggestions: rules, source: "rules" };
}
