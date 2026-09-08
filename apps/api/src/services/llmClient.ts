import { CALLS_ENABLED } from "../lib/featureFlags.ts";

/**
 * Optional LLM client. Used only to refine StructuredCommand JSON
 * or ConversationAnalysis JSON. Never calls sendMessage / messaging providers.
 */
export async function refineCommandWithLlm(rawText: string, ruleParsed: Record<string, unknown>) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANYMODEL_API_KEY;
  const baseUrl = process.env.ANYMODEL_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.ANYMODEL_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!apiKey) return null;

  const taskTypes = CALLS_ENABLED
    ? "proposal|message|call|follow_up|send_documents|other"
    : "proposal|message|follow_up|send_documents|other";
  const callHint = CALLS_ENABLED
    ? ""
    : " Звонки отключены: «позвони/созвонись» → taskType message.";

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              `Ты парсер CRM-команд. Верни JSON с полями: taskType (${taskTypes}), executionMode (execute|prepare_only), serviceCategories (WEB|PRESENTATION|ADVERTISING|BRANDING|AI[]), datePreset (today|yesterday|last_3_days|last_7_days|last_30_days|null), needsReply (bool), excludeWon (bool), proposalSentDaysAgo (number|null), clientNameQuery (string|null), intent (string), riskLevel (0-4). «скажи/напиши/сообщи что …» = taskType message. «отправь КП» = proposal. «отправь файл/документ» = send_documents.${callHint} Не выдумывай факты. Не отправляй сообщения.`,
          },
          {
            role: "user",
            content: `Команда: ${rawText}\nЧерновик правил: ${JSON.stringify(ruleParsed)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function refineConversationContextWithLlm(input: {
  messages: Array<{ role: string; text: string; at: string; id: string }>;
  draft: Record<string, unknown>;
  inquiryStatus: string | null;
  dealStage: string | null;
  openTaskTitles: string[];
  existingAgreements: Array<{ id: string; type: string; status: string; scheduledAt: string | null }>;
}) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANYMODEL_API_KEY;
  const baseUrl = process.env.ANYMODEL_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.ANYMODEL_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!apiKey) return null;

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Ты CRM Context Analyst. Анализируй КОНТЕКСТ переписки целиком, не одно сообщение.
Верни JSON ConversationAnalysis:
clientIntent, detectedNeed, suggestedRequestStatus (new|qualification|qualified|waiting_client|waiting_manager|null),
suggestedDealStage (только: need_identified|proposal_sent|negotiation|contract|null — НИКОГДА won/lost),
waitingFor (CLIENT|MANAGER|AI|THIRD_PARTY|NONE), needsReply,
agreements[{action:create|update|reschedule|cancel|complete, existingAgreementId, type, title, summary, purpose, status, scheduledAt ISO|null, locationName, address, meetingProvider, meetingUrl, clarificationNeeded, confidence HIGH|MEDIUM|LOW, createTask, taskType, evidenceMessageIds[]}],
suggestedTasks[{type,title,dueAt,purpose,briefingText,preparationHints[],linkedAgreementIndex,evidenceMessageIds[],confidence}],
suggestedNextAction, humanRequired, humanReason, summaryUpdate, evidenceMessageIds[], confidence, facts{service,budget,deadline,company,meetingDate,meetingTime}.
Типы agreement: CALL, ONLINE_MEETING, OFFLINE_MEETING, SEND_PROPOSAL, SEND_DOCUMENTS, SEND_CONTRACT, SEND_INVOICE, FOLLOW_UP, MESSAGE, PAYMENT_PROMISE, PREPARE_ESTIMATE, CLIENT_CALLBACK, MANAGER_CALLBACK, OTHER.
Статусы: DETECTED, NEEDS_CLARIFICATION, CONFIRMED, SCHEDULED, COMPLETED, RESCHEDULED, CANCELLED, MISSED.
Не выдумывай дату/время/место/ссылку если их нет в тексте. Не предлагай WON/LOST. Не отправляй сообщения.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              inquiryStatus: input.inquiryStatus,
              dealStage: input.dealStage,
              openTaskTitles: input.openTaskTitles,
              existingAgreements: input.existingAgreements,
              draft: input.draft,
              messages: input.messages,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function refineResultNextActionWithLlm(input: {
  taskType: string;
  resultCode: string;
  resultText: string | null;
  contactName: string | null;
  inquiryTitle: string | null;
  draft: unknown;
}) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANYMODEL_API_KEY;
  const baseUrl = process.env.ANYMODEL_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.ANYMODEL_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!apiKey) return null;

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Ты CRM Next Action Analyst. По результату звонка/встречи предложи следующие задачи.
Верни JSON: { suggestions: [{ type, title, dueOffsetHours|null, dueAt|null, purpose, suggestedDealStage|null, suggestedRequestStatus|null, requiresConfirm, reason }] }.
Типы задач: call, meeting, proposal, send_documents, prepare_estimate, follow_up, wait_client, payment, other.
suggestedDealStage только: need_identified|proposal_sent|negotiation|contract|null. Никогда won/lost.
Для договора/счёта/индивидуального КП всегда requiresConfirm=true.
Не выдумывай факты, которых нет в resultText.`,
          },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as {
      suggestions?: Array<{
        type?: string;
        title?: string;
        dueAt?: string | null;
        dueOffsetHours?: number | null;
        purpose?: string | null;
        suggestedDealStage?: string | null;
        suggestedRequestStatus?: string | null;
        requiresConfirm?: boolean;
        reason?: string;
      }>;
    };
  } catch {
    return null;
  }
}


export async function refineRequestAnalysisWithLlm(
  input: Record<string, unknown>,
  draft: Record<string, unknown>,
) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANYMODEL_API_KEY;
  const baseUrl = process.env.ANYMODEL_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.ANYMODEL_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!apiKey) return null;

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Ты CRM Request Analyst. Анализируй новую заявку. Верни JSON RequestAnalysis:
serviceCategory (web|presentation|advertising|branding|ai|other|null), serviceSubcategory,
detectedNeed, budgetMin, budgetMax, deadline, city, company,
knownFields[{key,label,value}], missingFields[{key,label}],
urgency (normal|high|urgent), recommendedAction, taskTitle, taskObjective, expectedOutcome,
qualificationQuestions[], confidence (HIGH|MEDIUM|LOW), evidence[].
Приоритет: текст клиента > поля формы > landing > кампания.
Не придумывай бюджет/срок/город/компанию, если их нет в данных.
taskTitle должен быть конкретным, не «Обработать новую заявку».`,
          },
          { role: "user", content: JSON.stringify({ input, draft }) },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const MAX_CAMPAIGN_LLM_RECIPIENTS = 40;

/** Adapt already-composed campaign drafts. Never sends messages; no phones or chat logs. */
export async function refineCampaignRecipientDraftsWithLlm(input: {
  taskText: string;
  clientAsk?: string | null;
  kind: string;
  hasFile: boolean;
  recipients: Array<{
    id: string;
    firstName: string | null;
    companyName: string | null;
    interest: string | null;
    draft: string;
  }>;
}) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANYMODEL_API_KEY;
  const baseUrl = process.env.ANYMODEL_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.ANYMODEL_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!apiKey || input.recipients.length === 0 || input.recipients.length > MAX_CAMPAIGN_LLM_RECIPIENTS) return null;

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Ты редактор CRM-рассылки. Задача менеджера — что нужно спросить или сделать, не готовый WhatsApp-текст. Сформулируй короткое сообщение клиенту именно об этой просьбе. Верни JSON { drafts: [{id, text}] }. 1–3 предложения, вежливо, на русском. Не подменяй задачу шаблоном «актуален ли ещё запрос», если менеджер просил другое (время созвона, оплату, документы и т.д.). Имя для обращения бери только из firstName; не используй ярлыки полей («Интерес», «Имя», «Компания») и не подставляй интерес вместо имени. Если имени нет — начни с «Добрый день!». Интерес и компанию можно упомянуть как контекст заявки. Не выдумывай цены, скидки, сроки, метрики, услуги и факты, которых нет во входных данных. Не добавляй телефоны. Не отправляй сообщения.",
          },
          {
            role: "user",
            content: JSON.stringify({
              task: input.taskText,
              clientAsk: input.clientAsk || undefined,
              kind: input.kind,
              hasFile: input.hasFile,
              recipients: input.recipients,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { drafts?: Array<{ id?: string; text?: string }> };
    const drafts = (parsed.drafts || [])
      .map((row) => ({ id: String(row.id || ""), text: String(row.text || "").trim() }))
      .filter((row) => row.id && row.text && row.text.length <= 4000);
    return drafts.length ? drafts : null;
  } catch {
    return null;
  }
}
