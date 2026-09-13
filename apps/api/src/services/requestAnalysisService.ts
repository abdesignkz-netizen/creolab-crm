import { looksLikeLeadFormDump } from "./contactInterestService.ts";
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
    category: "ai",
    subcategory: "manager",
    patterns: [/ии[- ]?менеджер/i, /ai[- ]?менеджер/i, /ai[- ]?manager/i],
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
  const rawClientText = [input.description, input.subject].filter(Boolean).join("\n");
  const clientText = looksLikeLeadFormDump(rawClientText) ? "" : rawClientText;
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
    clientText.trim() ||
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
    if (f.key === "use_case") {
      return "Какие задачи должен выполнять ИИ-менеджер: консультировать, квалифицировать заявки или записываться на встречу?";
    }
    if (f.key === "channels") return "Через какие каналы к вам приходят обращения — сайт, WhatsApp, телефон?";
    if (f.key === "integrations") return "Какая CRM используется и нужно ли связать с ней ИИ-менеджера?";
    return `Уточните, пожалуйста: ${f.label.toLowerCase()}?`;
  });

  const clientMessageDraft = buildClientMessageDraft({
    contactName: input.name,
    serviceLabel,
    service: input.service || input.subject,
    company,
    knownFields,
    qualificationQuestions,
    requestText: clientText || null,
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
  if (category === "ai") return "ИИ-решение";
  return "услугу";
}

function lowerFirst(value: string) {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function welcomeServicePhrase(service?: string | null, categoryLabel?: string) {
  const raw = String(service || "").replace(/\s+/g, " ").trim();
  if (raw && raw.length >= 3 && raw.length <= 80 && !looksLikeLeadFormDump(raw) && !isUnsuitableTopic(raw)) {
    return phraseServiceAsTopic(raw);
  }
  return categoryLabel || "услугу";
}

function phraseServiceAsTopic(service: string) {
  const text = service.replace(/\s+/g, " ").trim();
  if (/создан/i.test(text)) return lowerFirst(text);
  if (/ии[- ]?менеджер/i.test(text) || /ai[- ]?manager/i.test(text) || /ai[- ]?менеджер/i.test(text)) {
    return "создание ИИ-менеджера";
  }
  return lowerFirst(text)
    .replace(/^презентация(?=\s|$|,|\.|·)/i, "презентацию")
    .replace(/^реклама(?=\s|$|,|\.|·)/i, "рекламу");
}

function isUnsuitableTopic(text: string) {
  if (looksLikeLeadFormDump(text)) return true;
  if (/сайт или направление/i.test(text)) return true;
  if (/\b(cta|utm|lead-form)\b/i.test(text)) return true;
  if (/каналы\s*:/i.test(text) || /контакт\s*:/i.test(text) || /страница\s*:/i.test(text)) return true;
  if (/\+?\d[\d\s()-]{8,}\d/.test(text)) return true;
  if (/https?:\/\//i.test(text)) return true;
  return false;
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
  if (text.length < 12 || text.length > 4000) return null;
  if (/^\s*[{\[]/.test(text)) return null;
  if (/^Уже известно:/i.test(text)) return null;
  if (/не могу (отправить|написать)|скопируйте текст|задача менеджера/i.test(text)) return null;
  return text;
}

const AGENCY_INTRO = "Вас приветствует CreoLab Digital Agency";

function requestTopic(requestText: string | null | undefined, servicePhrase: string) {
  const raw = String(requestText || "").replace(/\s+/g, " ").trim();
  const stripped = raw
    .replace(/^(нужна|нужен|нужно|хотим|хочу|интересует|прошу)\s+/i, "")
    .replace(/[.!?…]+$/g, "")
    .trim();
  if (
    stripped.length >= 4 &&
    stripped.length <= 90 &&
    !/заявка по услуге/i.test(stripped) &&
    !isUnsuitableTopic(stripped)
  ) {
    const topic = stripped.charAt(0).toLowerCase() + stripped.slice(1);
    return topic
      .replace(/^презентация(?=\s|$|,|\.|·)/i, "презентацию")
      .replace(/^реклама(?=\s|$|,|\.|·)/i, "рекламу");
  }
  return servicePhrase;
}

function stripWelcomeNoise(body?: string | null) {
  let text = String(body || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text.replace(/^[А-ЯA-ZЁ][а-яa-zё-]+,\s*(?:добрый день|здравствуйте)[!.,]?\s*/i, "");
  text = text.replace(/^(?:добрый день|здравствуйте)[!.,]?\s*/i, "");
  text = text.replace(/вас приветствует creolab digital agency[,!.]?\s*/i, "");
  text = text.replace(/пишу по поводу вашей заявки на.+?(?=\.\s+[А-ЯЁA-Z]|Подскажите|Уточните|Напишите|$)/i, "");
  text = text.replace(/сайт или направление[:\s][^.?!]*/gi, "");
  text = text.replace(/\b(каналы|cta|контакт|страница)\s*:[^.?!]*/gi, "");
  text = text.replace(/https?:\/\/\S+/gi, "");
  text = text.replace(/\+?\d[\d\s()-]{8,}\d/g, "");
  text = text.replace(/^\.\s*/, "");
  text = text.replace(/понял(?:а)?,\s*что[^.?!]+[.?!]?\s*/i, "");
  text = text.replace(/получили вашу заявку[^.?!]+[.?!]?\s*/i, "");
  text = text.replace(/уже учли:[^.?!]+[.?!]?\s*/i, "");
  return text.trim();
}

function defaultWelcomeQuestions(questions: string[]) {
  const items = questions
    .filter(Boolean)
    .slice(0, 3)
    .map((item) =>
      item.replace(/^(уточните|подскажите),?\s*(пожалуйста[,:]?\s*)?/i, "").replace(/[?]+$/, "").trim(),
    )
    .filter(Boolean);
  if (!items.length) return "Подскажите, пожалуйста, детали задачи — подготовим следующий шаг.";
  return `Подскажите, пожалуйста: ${items.map((item) => item.replace(/[?]+$/, "")).join("; ")}?`;
}

export function formatInquiryWelcomeMessage(args: {
  contactName?: string | null;
  serviceLabel: string;
  service?: string | null;
  requestText?: string | null;
  body?: string | null;
  qualificationQuestions: string[];
}) {
  const firstName = greetingFirstName(args.contactName);
  const greeting = firstName ? `${firstName}, добрый день!` : "Добрый день!";
  const topic = requestTopic(args.requestText, welcomeServicePhrase(args.service, args.serviceLabel));
  const opening = `${greeting} ${AGENCY_INTRO}, пишу по поводу вашей заявки на ${topic}.`;
  const continuation = stripWelcomeNoise(args.body) || defaultWelcomeQuestions(args.qualificationQuestions);
  return `${opening} ${continuation}`.replace(/\s+/g, " ").trim();
}

function buildClientMessageDraft(args: {
  contactName?: string | null;
  serviceLabel: string;
  service?: string | null;
  company: string | null;
  knownFields: RequestAnalysis["knownFields"];
  qualificationQuestions: string[];
  requestText?: string | null;
  body?: string | null;
}) {
  return formatInquiryWelcomeMessage({
    contactName: args.contactName,
    serviceLabel: args.serviceLabel,
    service: args.service,
    requestText: args.requestText,
    body: args.body,
    qualificationQuestions: args.qualificationQuestions,
  });
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
  merged.clientMessageDraft = formatInquiryWelcomeMessage({
    contactName: input.name,
    serviceLabel: serviceLabelForCategory(merged.serviceCategory),
    service: input.service || input.subject,
    requestText: looksLikeLeadFormDump(input.description) ? null : input.description || input.subject || detectedNeed,
    body: sanitizeClientMessageDraft(refined.clientMessageDraft) || undefined,
    qualificationQuestions,
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
        "Это первое WhatsApp-сообщение по новой заявке CREOLAB.",
        "Система сама поставит начало: «Имя, добрый день! Вас приветствует CreoLab Digital Agency, пишу по поводу вашей заявки на …».",
        "Напиши только продолжение: 1–3 уточняющих вопроса по заявке, на «Вы», коротко.",
        "Не пиши «Понял, что нужна…», «получили заявку», не повторяй приветствие и название агентства.",
        "Не цитируй служебные поля заявки: каналы, CTA, контакт, страница, телефон, UTM.",
        "Не спрашивай телефон — он уже есть. Не выдумывай цены, сроки, портфолио и обещания.",
        analysis.qualificationQuestions.length
          ? `Ориентир по уточнениям: ${analysis.qualificationQuestions.slice(0, 3).join(" | ")}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      firstName: greetingFirstName(input.name),
      companyName: analysis.company,
      interest:
        [...new Set([input.service, looksLikeLeadFormDump(input.description) ? null : input.description, input.subject].filter(Boolean))]
          .join(" · ") || analysis.taskTitle,
    });
    analysis = {
      ...analysis,
      clientMessageDraft: formatInquiryWelcomeMessage({
        contactName: input.name,
        serviceLabel: serviceLabelForCategory(analysis.serviceCategory),
        service: input.service || input.subject,
        requestText: looksLikeLeadFormDump(input.description) ? null : input.description || input.subject || analysis.detectedNeed,
        body: composed,
        qualificationQuestions: analysis.qualificationQuestions,
      }),
    };
  } catch {
    return analysis;
  }
  return analysis;
}
