import { schemaForCategory } from "./qualificationSchemas.ts";

export type RequestAnalysis = {
  serviceCategory: string | null;
  serviceSubcategory: string | null;
  detectedNeed: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  deadline: string | null;
  city: string | null;
  company: string | null;
  knownFields: Array<{ key: string; label: string; value?: string | null }>;
  missingFields: Array<{ key: string; label: string }>;
  urgency: "normal" | "high" | "urgent";
  recommendedAction: string;
  taskTitle: string;
  /** Internal CRM briefing for the manager — not WhatsApp copy */
  taskObjective: string;
  /** Ready-to-send first WhatsApp message for the client */
  clientMessageDraft: string;
  expectedOutcome: string;
  qualificationQuestions: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
  evidence: string[];
};

type AnalyzeInput = {
  name?: string | null;
  companyName?: string | null;
  subject?: string | null;
  description?: string | null;
  service?: string | null;
  serviceCategory?: string | null;
  serviceSubcategory?: string | null;
  city?: string | null;
  desiredDeadline?: string | null;
  budgetMin?: number | null;
  budgetMax?: number | null;
  landingPage?: string | null;
  utmCampaign?: string | null;
  sourceChannel?: string | null;
  phoneNormalized?: string | null;
};

const SERVICE_HINTS: Array<{ category: string; subcategory?: string; patterns: RegExp[] }> = [
  {
    category: "presentation",
    subcategory: "investment",
    patterns: [/инвестиционн\w*\s+презентац/i, /pitch\s*deck/i, /питч/i],
  },
  {
    category: "presentation",
    patterns: [/презентац/i, /слайд/i, /deck/i],
  },
  {
    category: "web",
    subcategory: "corporate",
    patterns: [/корпоративн\w*\s+сайт/i, /сайт\s+компани/i],
  },
  {
    category: "web",
    subcategory: "landing",
    patterns: [/лендинг/i, /landing/i, /посадочн/i],
  },
  {
    category: "web",
    patterns: [/сайт/i, /website/i, /веб[- ]?сайт/i, /\bweb\b/i],
  },
  {
    category: "advertising",
    patterns: [/реклам/i, /таргет/i, /контекстн/i, /google\s*ads/i, /meta\s*ads/i],
  },
  {
    category: "branding",
    patterns: [/брендинг/i, /логотип/i, /фирменн\w*\s+стил/i, /айдентик/i],
  },
  {
    category: "ai",
    patterns: [/\bai\b/i, /нейросет/i, /чат[- ]?бот/i, /автоматизац/i],
  },
];

function detectServiceFromText(text: string): { category: string; subcategory: string | null } | null {
  for (const hint of SERVICE_HINTS) {
    if (hint.patterns.some((re) => re.test(text))) {
      return { category: hint.category, subcategory: hint.subcategory || null };
    }
  }
  return null;
}

function extractBudget(text: string): { min: number | null; max: number | null } {
  const range = text.match(/(\d[\d\s]*)\s*[–\-—]\s*(\d[\d\s]*)\s*(тыс|тысяч|млн|тг|₸|kzt)?/i);
  if (range) {
    const mult = /млн/i.test(range[3] || "") ? 1_000_000 : /тыс/i.test(range[3] || "") ? 1000 : 1;
    return {
      min: Math.round(Number(range[1].replace(/\s/g, "")) * mult),
      max: Math.round(Number(range[2].replace(/\s/g, "")) * mult),
    };
  }
  const single = text.match(/бюджет[^\d]{0,20}(\d[\d\s]*)\s*(тыс|тысяч|млн)?/i);
  if (single) {
    const mult = /млн/i.test(single[2] || "") ? 1_000_000 : /тыс/i.test(single[2] || "") ? 1000 : 1;
    const n = Math.round(Number(single[1].replace(/\s/g, "")) * mult);
    return { min: n, max: n };
  }
  return { min: null, max: null };
}

function extractDeadline(text: string): string | null {
  if (/сегодня|завтра|срочно|asap/i.test(text)) {
    if (/сегодня/i.test(text)) return "сегодня";
    if (/завтра/i.test(text)) return "завтра";
    return "срочно";
  }
  const month = text.match(/(в течение|за|через)\s+(\d+)\s*(дн|день|дня|недел|мес)/i);
  if (month) return `${month[1]} ${month[2]} ${month[3]}`;
  const about = text.match(/около\s+(месяца|недели|двух недель)/i);
  if (about) return `около ${about[1]}`;
  if (/в течение месяца|за месяц/i.test(text)) return "в течение месяца";
  return null;
}

function extractPages(text: string): string | null {
  const m = text.match(/(\d+)\s*страниц/i);
  return m ? `примерно ${m[1]} страниц` : null;
}

function extractCity(text: string): string | null {
  const m = text.match(/\b(Алматы|Астана|Атырау|Шымкент|Караганда|Актобе)\b/i);
  return m ? m[1] : null;
}

function detectUrgency(text: string, deadline: string | null): "normal" | "high" | "urgent" {
  if (/сегодня|срочно|asap|немедленно/i.test(text) || deadline === "сегодня") return "urgent";
  if (/завтра|как можно скорее|срочноват/i.test(text) || deadline === "завтра") return "high";
  return "normal";
}

/**
 * Priority: client free text > structured form fields > landing > campaign.
 * Never invent missing facts.
 */
export function analyzeRequestHeuristic(input: AnalyzeInput): RequestAnalysis {
  const clientText = [input.description, input.subject].filter(Boolean).join("\n");
  const structuredHint = [input.service, input.serviceCategory, input.landingPage, input.utmCampaign]
    .filter(Boolean)
    .join(" ");
  const evidence: string[] = [];

  let category = input.serviceCategory || null;
  let subcategory = input.serviceSubcategory || null;

  const fromClient = detectServiceFromText(clientText);
  if (fromClient) {
    category = fromClient.category;
    subcategory = fromClient.subcategory || subcategory;
    evidence.push("услуга из текста клиента");
  } else if (category) {
    evidence.push("услуга из поля формы");
  } else {
    const fromLanding = detectServiceFromText(structuredHint);
    if (fromLanding) {
      category = fromLanding.category;
      subcategory = fromLanding.subcategory;
      evidence.push("услуга из landing/кампании");
    }
  }

  const budgetFromText = extractBudget(clientText);
  const budgetMin = input.budgetMin ?? budgetFromText.min;
  const budgetMax = input.budgetMax ?? budgetFromText.max;
  if (budgetMin != null || budgetMax != null) evidence.push("бюджет");

  const deadline = input.desiredDeadline || extractDeadline(clientText);
  if (deadline) evidence.push("срок");

  const city = input.city || extractCity(clientText);
  if (city) evidence.push("город");

  const company = input.companyName || null;
  if (company) evidence.push("компания");

  const pages = extractPages(clientText);
  const detectedNeed =
    input.description?.trim() ||
    input.subject?.trim() ||
    input.service?.trim() ||
    (category ? `Заявка по услуге ${category}` : null);

  const schema = schemaForCategory(category);
  const knownFields: RequestAnalysis["knownFields"] = [];
  const knownKeys = new Set<string>();

  const mark = (key: string, label: string, value?: string | null) => {
    if (!value && value !== "") return;
    if (knownKeys.has(key)) return;
    knownKeys.add(key);
    knownFields.push({ key, label, value: value || null });
  };

  if (category) mark("service", "Услуга", category);
  if (subcategory === "corporate" || /корпоратив/i.test(clientText)) {
    mark("site_type", "Тип сайта", "корпоративный");
  }
  if (pages) mark("structure", "Примерный объём", pages);
  if (deadline) mark("deadline", "Срок", deadline);
  if (budgetMin != null || budgetMax != null) {
    mark(
      "budget",
      "Бюджет",
      budgetMin != null && budgetMax != null && budgetMin !== budgetMax
        ? `${budgetMin}–${budgetMax}`
        : String(budgetMin ?? budgetMax),
    );
  }
  if (company) mark("company", "Компания", company);
  if (city) mark("city", "Город", city);
  if (input.phoneNormalized) mark("phone", "Телефон", input.phoneNormalized);

  const missingFields = schema
    .filter((f) => !knownKeys.has(f.key))
    .map((f) => ({ key: f.key, label: f.label }));

  const companyPart = company ? ` ${company}` : "";
  const serviceLabel = serviceLabelForCategory(category);

  const knownSummary = knownFields
    .filter((f) => f.key !== "phone")
    .map((f) => (f.value ? `${f.label} — ${f.value}` : f.label))
    .join(", ");

  const missingSummary = missingFields.map((f) => f.label.toLowerCase()).join(", ");

  const taskTitle = `Квалифицировать заявку${companyPart} на ${serviceLabel}`.replace(/\s+/g, " ").trim();
  const expectedOutcome = "Квалифицировать потребность и определить следующий коммерческий шаг.";
  const taskObjective = [
    knownSummary ? `Уже известно: ${knownSummary}.` : null,
    missingSummary ? `Уточнить: ${missingSummary}.` : null,
    `Цель: ${expectedOutcome}`,
  ]
    .filter(Boolean)
    .join(" ");

  const urgency = detectUrgency(clientText, deadline);
  const qualificationQuestions = missingFields.slice(0, 4).map((f) => {
    if (f.key === "site_goal" || f.key === "goal") {
      return "Какая основная задача: презентация компании или получение заявок?";
    }
    if (f.key === "functionality") return "Какой функционал критичен для запуска?";
    if (f.key === "materials") return "Есть ли готовые материалы (тексты, фото, брендбук)?";
    if (f.key === "budget") return "Какой ориентировочный бюджет рассматриваете?";
    if (f.key === "site_type") return "Какой тип сайта нужен: корпоративный, лендинг или интернет-магазин?";
    if (f.key === "audience") return "Кто ваша целевая аудитория?";
    if (f.key === "structure") return "Какой примерно объём/структура (сколько страниц или разделов)?";
    if (f.key === "deadline") return "К какому сроку нужен результат?";
    return `Уточните, пожалуйста: ${f.label.toLowerCase()}?`;
  });

  const clientMessageDraft = buildClientMessageDraft({
    contactName: input.name,
    serviceLabel,
    company,
    knownFields,
    qualificationQuestions,
    requestText: input.description || input.subject || detectedNeed,
  });

  return {
    serviceCategory: category,
    serviceSubcategory: subcategory,
    detectedNeed,
    budgetMin,
    budgetMax,
    deadline,
    city,
    company,
    knownFields,
    missingFields,
    urgency,
    recommendedAction: taskObjective,
    taskTitle,
    taskObjective,
    clientMessageDraft,
    expectedOutcome,
    qualificationQuestions,
    confidence: fromClient || category ? "MEDIUM" : "LOW",
    evidence,
  };
}

function serviceLabelForCategory(category?: string | null) {
  if (category === "web") return "сайт";
  if (category === "presentation") return "презентацию";
  if (category === "advertising") return "рекламу";
  if (category === "branding") return "брендинг";
  if (category === "ai") return "AI-решение";
  return "заявку";
}

function greetingFirstName(name?: string | null) {
  const first = String(name || "")
    .trim()
    .split(/\s+/)[0];
  if (!first || first.length < 2) return null;
  if (/^(клиент|lead|test|тест|интерес|\+?\d)/i.test(first)) return null;
  return first;
}

export function sanitizeClientMessageDraft(raw: unknown): string | null {
  const text = String(raw || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (text.length < 24 || text.length > 4000) return null;
  if (/^\s*[{\[]/.test(text)) return null;
  if (/^Уже известно:/i.test(text)) return null;
  if (/не могу (отправить|написать)|скопируйте текст|задача менеджера/i.test(text)) return null;
  return text;
}

function buildClientMessageDraft(args: {
  contactName?: string | null;
  serviceLabel: string;
  company: string | null;
  knownFields: RequestAnalysis["knownFields"];
  qualificationQuestions: string[];
  requestText?: string | null;
}) {
  const firstName = greetingFirstName(args.contactName);
  const greeting = firstName ? `Здравствуйте, ${firstName}!` : "Здравствуйте!";
  const requestText = String(args.requestText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  const looksGeneric = !requestText || /заявка по услуге/i.test(requestText);
  const requestLower = requestText.toLowerCase();
  const knownBits = args.knownFields
    .filter((field) => field.key !== "phone" && field.value)
    .filter((field) => !requestLower.includes(String(field.value).toLowerCase()))
    .slice(0, 2)
    .map((field) => `${field.label.toLowerCase()} — ${field.value}`);

  const contextLine = [
    looksGeneric
      ? `Получили вашу заявку на ${args.serviceLabel}${args.company ? ` (${args.company})` : ""}.`
      : `Получили вашу заявку${args.company ? ` от ${args.company}` : ""}: ${requestText}${/[.!?…]$/.test(requestText) ? "" : "."}`,
    knownBits.length ? `Уже учли: ${knownBits.join("; ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const questions = args.qualificationQuestions.slice(0, 3);
  const askBlock = questions.length
    ? ["Чтобы точнее понять задачу, напишите пожалуйста:", ...questions.map((question, index) => `${index + 1}. ${question}`)].join(
        "\n",
      )
    : "Напишите, пожалуйста, детали задачи — подготовим следующий шаг.";

  return [greeting, contextLine, askBlock].filter(Boolean).join("\n\n");
}

export function applyRefinedRequestAnalysis(
  draft: RequestAnalysis,
  refined: Record<string, unknown> | null | undefined,
  input: AnalyzeInput,
): RequestAnalysis {
  if (!refined) return draft;
  const knownFields = Array.isArray(refined.knownFields)
    ? (refined.knownFields as RequestAnalysis["knownFields"])
    : draft.knownFields;
  const missingFields = Array.isArray(refined.missingFields)
    ? (refined.missingFields as RequestAnalysis["missingFields"])
    : draft.missingFields;
  const qualificationQuestions = Array.isArray(refined.qualificationQuestions)
    ? (refined.qualificationQuestions as string[])
    : draft.qualificationQuestions;
  const serviceCategory =
    typeof refined.serviceCategory === "string" ? refined.serviceCategory : draft.serviceCategory;
  const company = draft.company;
  const detectedNeed = typeof refined.detectedNeed === "string" ? refined.detectedNeed : draft.detectedNeed;
  const merged: RequestAnalysis = {
    ...draft,
    serviceCategory,
    serviceSubcategory:
      typeof refined.serviceSubcategory === "string" ? refined.serviceSubcategory : draft.serviceSubcategory,
    detectedNeed,
    knownFields,
    missingFields,
    qualificationQuestions,
    evidence: Array.isArray(refined.evidence) ? (refined.evidence as string[]) : draft.evidence,
    taskTitle: typeof refined.taskTitle === "string" ? refined.taskTitle : draft.taskTitle,
    taskObjective: typeof refined.taskObjective === "string" ? refined.taskObjective : draft.taskObjective,
    expectedOutcome: typeof refined.expectedOutcome === "string" ? refined.expectedOutcome : draft.expectedOutcome,
    recommendedAction:
      typeof refined.recommendedAction === "string" ? refined.recommendedAction : draft.recommendedAction,
    urgency:
      refined.urgency === "urgent" || refined.urgency === "high" || refined.urgency === "normal"
        ? refined.urgency
        : draft.urgency,
    confidence:
      refined.confidence === "HIGH" || refined.confidence === "MEDIUM" || refined.confidence === "LOW"
        ? refined.confidence
        : draft.confidence,
    budgetMin: draft.budgetMin,
    budgetMax: draft.budgetMax,
    deadline: draft.deadline,
    city: draft.city,
    company,
  };
  merged.clientMessageDraft =
    sanitizeClientMessageDraft(refined.clientMessageDraft) ||
    buildClientMessageDraft({
      contactName: input.name,
      serviceLabel: serviceLabelForCategory(merged.serviceCategory),
      company,
      knownFields,
      qualificationQuestions,
      requestText: input.description || input.subject || detectedNeed,
    });
  return merged;
}

export async function analyzeRequestWithOptionalLlm(input: AnalyzeInput): Promise<RequestAnalysis> {
  const draft = analyzeRequestHeuristic(input);
  let analysis = draft;
  try {
    const { refineRequestAnalysisWithLlm, composeClientMessageWithLlm } = await import("./llmClient.ts");
    const refined = await refineRequestAnalysisWithLlm(input, draft);
    analysis = applyRefinedRequestAnalysis(draft, refined, input);
    const composed = await composeClientMessageWithLlm({
      instruction: [
        "Напиши первое WhatsApp-сообщение по новой заявке CREOLAB.",
        "Покажи, что понял конкретный запрос клиента своими словами.",
        "Уточни 1–3 недостающих детали, чтобы квалифицировать заявку и предложить следующий шаг.",
        "Не спрашивай телефон — он уже есть. Не выдумывай цены, сроки, портфолио и обещания.",
        "Не пиши «чем могу помочь» и не представляйся роботом.",
        analysis.qualificationQuestions.length
          ? `Ориентир по уточнениям: ${analysis.qualificationQuestions.slice(0, 3).join(" | ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      firstName: greetingFirstName(input.name),
      companyName: analysis.company,
      interest:
        [input.description, input.subject, analysis.detectedNeed].filter(Boolean).join(" · ") || analysis.taskTitle,
    });
    const fromLlm = sanitizeClientMessageDraft(composed);
    if (fromLlm) analysis = { ...analysis, clientMessageDraft: fromLlm };
  } catch {
    return analysis;
  }
  return analysis;
}
