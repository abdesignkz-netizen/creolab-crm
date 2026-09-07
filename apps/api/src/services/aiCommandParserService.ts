import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { refineCommandWithLlm } from "./llmClient.ts";
import { SERVICE_CATEGORIES, previewContactSegment, searchContactsForPicker } from "./segmentService.ts";
import { TASK_TYPE_LABEL } from "./contactLabels.ts";

export type StructuredCommand = {
  rawText: string;
  intent: string;
  taskType: string;
  actionLabel: string;
  targetType: "client" | "group" | "none";
  executionMode: "execute" | "prepare_only";
  riskLevel: number;
  confidence: "high" | "medium" | "low";
  filters: {
    serviceCategories?: string[];
    datePreset?: string;
    dateField?: string;
    needsReply?: boolean;
    excludeWon?: boolean;
    proposalSentDaysAgo?: number;
    statuses?: string[];
  };
  clientNameQuery?: string | null;
  ambiguities: string[];
  understandingLabel: string;
};

const WHITELIST = new Set([
  "search_clients",
  "create_task",
  "call",
  "message",
  "follow_up",
  "send_proposal",
  "send_document",
  "prepare_only",
]);

function normalize(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Pull client-facing text from «скажи что …» / «напиши …». */
export function extractSpokenMessage(rawText: string): string | null {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const patterns = [
    /(?:скажи|скажите|сказать|напиши|напишите|написать|сообщи|сообщите|сообщить|переда|передай|передайте)\s+(?:клиенту\s+|им\s+|ему\s+|ей\s+)?что\s+(.+)/i,
    /(?:скажи|скажите|напиши|напишите|сообщи|переда)\s+(?:клиенту\s+|им\s+)?(.+)/i,
    /(?:отправь|отправьте|отправить)\s+(?:ему\s+|ей\s+|им\s+|клиенту\s+)?(?:сообщение|текст|смс)\s*[:\-–]?\s*(.+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      let body = m[1].trim().replace(/[.!?…]+$/u, "");
      // Drop trailing recipient fluff if any
      body = body.replace(/\s+(пожалуйста|pls)$/i, "").trim();
      if (body.length < 2) continue;
      return body.charAt(0).toUpperCase() + body.slice(1) + (/[.!?]$/.test(body) ? "" : ".");
    }
  }
  return null;
}

function parseRules(rawText: string): StructuredCommand {
  const text = normalize(rawText);
  const ambiguities: string[] = [];
  let taskType = "other";
  let intent = "create_task";
  let executionMode: "execute" | "prepare_only" = "execute";
  let riskLevel = 2;
  let confidence: "high" | "medium" | "low" = "medium";

  const prepareOnly = /подготов(ь|ьте|ить)|не отправля|черновик|draft/.test(text);
  if (prepareOnly) {
    executionMode = "prepare_only";
    intent = "prepare_only";
    riskLevel = 1;
  }

  if (/рассылк|разошли|всем\s+этим|список\s+номер|массову/.test(text) || (/\d{10,}/.test(text) && /отправ/.test(text))) {
    ambiguities.push("Массовая отправка: откройте режим Campaign / Массовая отправка для подтверждения.");
  }

  const isMessageVerb =
    /(?:^|\s)(скажи|скажите|сказать|напиш\w*|сообщ\w*|переда\w*|напиши|написать)(?:\s|$)/.test(text) ||
    /отправ(ь|ьте|ить).{0,20}(сообщен|текст|смс)/.test(text) ||
    /(?:в\s+)?(?:whatsapp|вотсап|вацап|wa)\b/.test(text);

  if (/\b(кп|коммерческ\w*\s+предложен\w*|proposal)\b/.test(text) || /отправ(ь|ьте|ить).{0,40}(кп|предложен)/.test(text)) {
    taskType = "proposal";
    intent = "send_proposal";
    riskLevel = executionMode === "prepare_only" ? 1 : 3;
  } else if (
    /отправ(ь|ьте|ить).{0,30}(файл|документ|договор|презентац|вложен)/.test(text) &&
    !/скажи|напиш|сообщ|переда/.test(text)
  ) {
    taskType = "send_documents";
    intent = "send_document";
    riskLevel = executionMode === "prepare_only" ? 1 : 3;
  } else if (/позвон|перезвон|созвон/.test(text)) {
    taskType = "call";
    intent = "call";
    riskLevel = 2;
  } else if (/напомн/.test(text) && !isMessageVerb) {
    taskType = "follow_up";
    intent = "follow_up";
    riskLevel = 2;
  } else if (isMessageVerb || /уточн/.test(text)) {
    taskType = "message";
    intent = "message";
    riskLevel = executionMode === "prepare_only" ? 1 : 3;
    confidence = "high";
  } else if (/найд|покаж|список|кто\s/.test(text) && !/отправ|позвон|напиш|скажи/.test(text)) {
    intent = "search_clients";
    taskType = "other";
    riskLevel = 0;
    confidence = "high";
  } else {
    ambiguities.push("Не удалось однозначно определить действие");
    confidence = "low";
  }

  const serviceCategories: string[] = [];
  if (/сайт|лендинг|web|интернет.?магазин|корпоративн/.test(text)) serviceCategories.push("WEB");
  if (/презентац|pitch|deck/.test(text)) serviceCategories.push("PRESENTATION");
  if (/реклам|google\s*ads|meta|tiktok/.test(text)) serviceCategories.push("ADVERTISING");
  if (/бренд|логотип/.test(text)) serviceCategories.push("BRANDING");
  if (/ai\s*manager|ии.?менеджер/.test(text)) serviceCategories.push("AI");

  let datePreset: string | undefined;
  let dateField = "lastContact";
  if (/сегодняшн|сегодня/.test(text) && !/отправ/.test(text.split("сегодня")[0] || "")) datePreset = "today";
  if (/вчерашн|вчера/.test(text)) datePreset = "yesterday";
  if (/позавчера/.test(text)) datePreset = "last_3_days";
  if (/последн(ие|их)\s*3\s*дн/.test(text)) datePreset = "last_3_days";
  if (/последн(ие|их)\s*7\s*дн|за\s*недел|на этой неделе/.test(text)) datePreset = "last_7_days";
  if (/последн(ие|их)\s*30\s*дн|за\s*месяц|в этом месяце/.test(text)) datePreset = "last_30_days";

  // «кому вчера отправили КП» vs «вчерашним клиентам»
  let proposalSentDaysAgo: number | undefined;
  if (/кому.{0,20}(отправ|послал).{0,20}(кп|предложен)/.test(text) || /(кп|предложен).{0,20}(отправ|послал).{0,30}(вчера|3\s*дн|три\s*дн)/.test(text)) {
    if (/вчера/.test(text)) proposalSentDaysAgo = 1;
    else if (/3\s*дн|три\s*дн/.test(text)) proposalSentDaysAgo = 3;
    datePreset = undefined;
    dateField = "lastContact";
  } else if (datePreset === "yesterday" || datePreset === "today") {
    dateField = "inquiryCreated";
  }

  const needsReply = /не\s*ответил|ждут\s*ответа|без\s*ответа/.test(text);
  const excludeWon = /не\s*купил|без\s*продаж|не\s*закрыл/.test(text);

  let clientNameQuery: string | null = null;
  const nameMatch =
    text.match(/(?:напиш|позвон|уточн|скажи|сообщи|переда)[а-яёa-z]*\s+([а-яёa-z]{3,})/i) ||
    text.match(/клиент[а-яёa-z]*\s+([а-яёa-z]{3,})/i);
  const stop = new Set([
    "всем",
    "тем",
    "сегодня",
    "вчера",
    "клиентам",
    "новым",
    "этим",
    "им",
    "что",
    "ему",
    "ей",
    "файл",
    "доку",
    "готов",
  ]);
  if (nameMatch?.[1] && !stop.has(nameMatch[1].toLowerCase()) && !/презентац|сайт|реклам|бренд|файл|готов/.test(nameMatch[1])) {
    // stem common RU case endings so «Александру» → «Александр»
    const rawName = nameMatch[1];
    const stemmed = rawName.replace(/(у|ю|ом|ой|ей|ём|е|а|я)$/i, "");
    clientNameQuery = stemmed.length >= 3 ? stemmed : rawName;
  }

  let targetType: "client" | "group" | "none" = "group";
  if (clientNameQuery) targetType = "client";
  if (intent === "search_clients") targetType = "group";
  if (!clientNameQuery && !datePreset && !serviceCategories.length && !needsReply && !excludeWon && proposalSentDaysAgo == null) {
    if (intent !== "search_clients") {
      ambiguities.push("Не указано, кому относится задача");
      confidence = "low";
    }
  }

  if (serviceCategories.length && datePreset && taskType !== "other") confidence = "high";
  if (clientNameQuery && taskType !== "other") confidence = "high";
  if (taskType === "message" && extractSpokenMessage(rawText)) confidence = confidence === "low" ? "medium" : confidence;

  const serviceLabels = serviceCategories
    .map((id) => SERVICE_CATEGORIES.find((item) => item.id === id)?.label || id)
    .join(", ");
  const actionLabel = TASK_TYPE_LABEL[taskType] || taskType;
  const whenLabel =
    proposalSentDaysAgo != null
      ? `кому отправляли КП ${proposalSentDaysAgo === 1 ? "вчера" : `${proposalSentDaysAgo} дн. назад`}`
      : datePreset === "today"
        ? "сегодняшним"
        : datePreset === "yesterday"
          ? "вчерашним"
          : datePreset || "без периода";

  const understandingLabel = [
    actionLabel,
    clientNameQuery ? `клиент «${clientNameQuery}»` : "группа клиентов",
    serviceLabels || null,
    whenLabel,
    needsReply ? "не ответили" : null,
    excludeWon ? "не купили" : null,
    executionMode === "prepare_only" ? "только подготовка" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    rawText,
    intent: WHITELIST.has(intent) ? intent : "create_task",
    taskType,
    actionLabel,
    targetType,
    executionMode,
    riskLevel,
    confidence,
    filters: {
      serviceCategories: serviceCategories.length ? serviceCategories : undefined,
      datePreset,
      dateField,
      needsReply: needsReply || undefined,
      excludeWon: excludeWon || undefined,
      proposalSentDaysAgo,
    },
    clientNameQuery,
    ambiguities,
    understandingLabel,
  };
}

function mergeLlm(base: StructuredCommand, llm: Record<string, unknown> | null): StructuredCommand {
  if (!llm) return base;
  const next = { ...base, filters: { ...base.filters } };
  if (typeof llm.taskType === "string" && llm.taskType) next.taskType = llm.taskType;
  if (llm.executionMode === "prepare_only" || llm.executionMode === "execute") next.executionMode = llm.executionMode;
  if (Array.isArray(llm.serviceCategories)) next.filters.serviceCategories = llm.serviceCategories.map(String);
  if (typeof llm.datePreset === "string") next.filters.datePreset = llm.datePreset;
  if (typeof llm.needsReply === "boolean") next.filters.needsReply = llm.needsReply;
  if (typeof llm.excludeWon === "boolean") next.filters.excludeWon = llm.excludeWon;
  if (typeof llm.proposalSentDaysAgo === "number") next.filters.proposalSentDaysAgo = llm.proposalSentDaysAgo;
  if (typeof llm.clientNameQuery === "string") next.clientNameQuery = llm.clientNameQuery;
  if (typeof llm.riskLevel === "number") next.riskLevel = llm.riskLevel;
  next.actionLabel = TASK_TYPE_LABEL[next.taskType] || next.taskType;
  return next;
}

function contactToPicker(contact: {
  id: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  lifecycleStatus: string;
  lastContactAt: Date | null;
  methods: Array<{ type: string; rawValue: string; primary: boolean }>;
  inquiries: Array<{ id: string; service: string | null; subject: string | null; status: string }>;
  conversations: Array<{ id: string }>;
  deals: Array<{ id: string }>;
}) {
  const phone = contact.methods.find((m) => m.type === "phone" && m.primary) || contact.methods.find((m) => m.type === "phone");
  const inquiry = contact.inquiries[0];
  return {
    id: contact.id,
    name: contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Без имени",
    phone: phone?.rawValue || null,
    companyName: contact.companyName,
    interest: inquiry?.service || inquiry?.subject || null,
    statusLabel: inquiry?.status || contact.lifecycleStatus,
    source: null,
    lastContactLabel: contact.lastContactAt ? new Date(contact.lastContactAt).toLocaleString("ru-RU") : null,
    inquiryId: inquiry?.id || null,
    dealId: contact.deals[0]?.id || null,
    conversationId: contact.conversations[0]?.id || null,
  };
}

export async function parseTaskCommand(
  prisma: PrismaClient,
  auth: AuthContext,
  text: string,
  opts: { contactId?: string; contactIds?: string[]; phone?: string; phones?: string[]; phoneListText?: string } = {},
) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  let command = parseRules(text);
  const llm = await refineCommandWithLlm(text, command as unknown as Record<string, unknown>);
  command = mergeLlm(command, llm);

  let clients: Array<Record<string, unknown>> = [];
  let total = 0;
  let selectable = 0;
  let needsClarification = false;
  let phoneUnresolved: string | null = null;
  let phonesUnresolved: string[] = [];

  const contactIds = [...new Set([...(opts.contactIds || []), ...(opts.contactId ? [opts.contactId] : [])])].slice(0, 500);
  const phonesFromOpts = [...new Set([...(opts.phones || []), ...(opts.phone ? [opts.phone] : [])].map((p) => p.trim()).filter(Boolean))];
  const phonesFromBlob = opts.phoneListText
    ? opts.phoneListText
        .split(/[\n,;]+/)
        .map((p) => p.trim())
        .filter((p) => p.replace(/\D/g, "").length >= 10)
    : [];
  const phones = [...new Set([...phonesFromOpts, ...phonesFromBlob])].slice(0, 500);

  if (contactIds.length) {
    const rows = await prisma.contact.findMany({
      where: { id: { in: contactIds }, tenantId: auth.activeMembership.tenantId, archivedAt: null },
      include: {
        methods: true,
        inquiries: { where: { archived: false }, orderBy: { receivedAt: "desc" }, take: 5 },
        conversations: { orderBy: { updatedAt: "desc" }, take: 3 },
        deals: { where: { outcome: "open" }, take: 3 },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    clients = contactIds.map((id) => byId.get(id)).filter(Boolean).map((row) => contactToPicker(row!));
    if (clients.length < contactIds.length) {
      command.ambiguities.push("Часть выбранных клиентов не найдена");
      needsClarification = true;
    }
    total = clients.length;
    selectable = clients.filter((item) => item.conversationId || item.phone).length;
    command.targetType = clients.length > 1 ? "group" : "client";
    command.clientNameQuery = clients.length === 1 ? String(clients[0].name) : `${clients.length} клиентов`;
    command.ambiguities = command.ambiguities.filter(
      (item) => !/не указано, кому|не удалось однозначно определить действие/i.test(item),
    );
    if (clients.length && command.taskType !== "other") command.confidence = "high";
    else if (clients.length && command.confidence === "low" && command.taskType !== "other") command.confidence = "high";
  } else if (phones.length) {
    const foundClients: Array<Record<string, unknown>> = [];
    for (const phone of phones) {
      const found = await searchContactsForPicker(prisma, auth, phone);
      if (found.clients.length === 0) {
        phonesUnresolved.push(phone);
      } else if (found.clients.length === 1) {
        foundClients.push(found.clients[0]);
      } else {
        // ambiguous: keep all matches so user can pick in UI
        foundClients.push(...found.clients);
        command.ambiguities.push(`По номеру ${phone} найдено ${found.clients.length} клиентов — отметьте нужных`);
        needsClarification = true;
      }
    }
    const uniq = new Map(foundClients.map((item) => [String(item.id), item]));
    clients = [...uniq.values()];
    total = clients.length;
    selectable = clients.filter((item) => item.conversationId || item.phone).length;
    phoneUnresolved = phonesUnresolved[0] || null;
    if (phonesUnresolved.length) {
      command.ambiguities.push(
        phonesUnresolved.length === 1
          ? `Клиент с номером ${phonesUnresolved[0]} не найден — создадим при постановке`
          : `${phonesUnresolved.length} номеров не найдены — создадим клиентов при постановке`,
      );
      command.confidence = "medium";
    }
    command.targetType = clients.length + phonesUnresolved.length > 1 ? "group" : "client";
    command.clientNameQuery =
      clients.length + phonesUnresolved.length === 1
        ? String(clients[0]?.name || phonesUnresolved[0] || phones[0])
        : `${clients.length + phonesUnresolved.length} получателей`;
    command.ambiguities = command.ambiguities.filter((item) => !/не указано, кому|не найдено$/i.test(item));
    if ((clients.length || phonesUnresolved.length) && command.confidence === "low" && command.taskType !== "other") {
      command.confidence = "high";
    }
  } else if (command.clientNameQuery) {
    const found = await searchContactsForPicker(prisma, auth, command.clientNameQuery);
    clients = found.clients;
    total = found.total;
    if (clients.length === 0) {
      command.ambiguities.push(`Клиент «${command.clientNameQuery}» не найден`);
      command.confidence = "low";
      needsClarification = true;
    } else if (clients.length > 1) {
      command.ambiguities.push(`Найдено ${clients.length} клиентов с именем «${command.clientNameQuery}». Выберите нужных.`);
      command.confidence = "medium";
      needsClarification = true;
      command.targetType = "group";
    } else {
      command.targetType = "client";
      selectable = 1;
    }
  } else {
    const segment = await previewContactSegment(prisma, auth, {
      serviceCategories: command.filters.serviceCategories,
      datePreset: command.filters.datePreset,
      dateField: (command.filters.dateField as "lastContact" | "firstContact" | "inquiryCreated" | "lastMessage") || "lastContact",
      needsReply: command.filters.needsReply,
      excludeWon: command.filters.excludeWon,
      proposalSentDaysAgo: command.filters.proposalSentDaysAgo,
      limit: 80,
    });
    clients = segment.clients;
    total = segment.total;
    selectable = clients.filter((item) => item.conversationId || item.phone).length;
  }

  const pendingPhones = phonesUnresolved.length;
  if (total === 0 && !pendingPhones && command.intent !== "search_clients") {
    if (!contactIds.length && !phones.length) {
      command.ambiguities.push("Укажите клиента или телефон — или уточните группу в команде");
    } else if (!pendingPhones) {
      command.ambiguities.push("По выбранным условиям клиентов не найдено");
    }
  }

  const recipientCount = total + pendingPhones;
  const massSend =
    recipientCount > 1 &&
    ["send_proposal", "send_document", "message"].includes(command.intent) &&
    command.executionMode !== "prepare_only";
  const asCampaign = massSend || recipientCount > 30 || Boolean(opts.phoneListText?.trim());

  if (recipientCount > 30 && !asCampaign && command.riskLevel >= 3) {
    command.ambiguities.push(`Слишком много получателей (${recipientCount}). Используйте массовую отправку (Campaign).`);
    needsClarification = true;
  }

  const status = needsClarification || command.confidence === "low" ? "needs_clarification" : "parsed";
  const suggestedDraft =
    command.taskType === "message"
      ? extractSpokenMessage(text) || "Добрый день! Хотел уточнить по вашей заявке."
      : command.taskType === "proposal"
        ? "Добрый день! Во вложении коммерческое предложение. Готовы обсудить детали."
        : command.taskType === "send_documents"
          ? "Добрый день! Направляем документы во вложении."
          : null;

  return {
    status,
    command,
    asCampaign,
    suggestedDraft,
    understanding: {
      title: "CRM поняла задачу так",
      action: command.actionLabel,
      who:
        pendingPhones && !clients.length
          ? pendingPhones === 1
            ? `Новый клиент · ${phonesUnresolved[0]}`
            : `${pendingPhones} новых номеров`
          : command.clientNameQuery
            ? command.clientNameQuery.startsWith("Клиент") || /\d+ (клиент|получател)/.test(command.clientNameQuery)
              ? command.clientNameQuery
              : `Клиент «${command.clientNameQuery}»`
            : `Клиентам${command.filters.datePreset === "yesterday" ? ", обратившимся вчера" : command.filters.datePreset === "today" ? ", обратившимся сегодня" : ""}`,
      interest:
        command.filters.serviceCategories
          ?.map((id) => SERVICE_CATEGORIES.find((item) => item.id === id)?.label || id)
          .join(", ") || "Любой интерес",
      found: recipientCount,
      canExecute: asCampaign ? Math.min(recipientCount, 500) : Math.min((selectable || total) + pendingPhones, 30),
      needsClarification: clients.length && needsClarification ? clients.length : Math.max(0, total - (selectable || total)),
      when: command.executionMode === "prepare_only" ? "Только подготовка" : "Сейчас (после подтверждения)",
      executor: "CRM / AI Manager",
      label: command.understandingLabel,
      consequence: asCampaign
        ? "Это массовая отправка: откроется Campaign с проверкой получателей и подтверждением."
        : command.riskLevel >= 3
          ? "После подтверждения CRM отправит сообщение клиенту через WhatsApp."
          : command.taskType === "call"
            ? "После подтверждения CRM создаст задачу звонка ответственному."
            : "CRM подготовит действие без внешней отправки.",
    },
    clients: clients.slice(0, asCampaign ? 500 : 30),
    total: recipientCount,
    phoneUnresolved,
    phonesUnresolved,
  };
}
