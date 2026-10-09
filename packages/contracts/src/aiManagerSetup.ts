import { z } from "zod";

export const AI_MANAGER_ROLES = ["consultation", "sales", "qualification", "booking", "support"] as const;
export type AiManagerRole = (typeof AI_MANAGER_ROLES)[number];
export const AI_MANAGER_ROLE_LABELS: Record<AiManagerRole, string> = {
  consultation: "Консультация", sales: "Продажи", qualification: "Квалификация заявок", booking: "Запись на услугу", support: "Поддержка",
};
const field = (max = 4000) => z.string().trim().max(max).default("");
const itemId = z.string().min(1).max(100);
export const aiManagerDraftSchema = z.object({
  version: z.literal(1).default(1),
  primaryRole: z.enum(AI_MANAGER_ROLES).default("consultation"),
  additionalRoles: z.array(z.enum(AI_MANAGER_ROLES)).max(4).default([]),
  company: z.object({ name: field(300), description: field(), audience: field(2000), geography: field(1500), contacts: field(2000), hours: field(1500) }).default({ name: "", description: "", audience: "", geography: "", contacts: "", hours: "" }),
  offerings: z.array(z.object({ id: itemId, name: field(300), description: field(), price: field(1000), includes: field(2000), timing: field(1000), restrictions: field(2000) })).max(30).default([]),
  conversation: z.object({ goal: field(2000), questions: field(4000), completion: field(2000), style: z.enum(["friendly", "business", "concise"]).default("friendly"), assistantName: field(150), greeting: field(1000), benefits: field(3000), objections: field(4000) }).default({ goal: "", questions: "", completion: "", style: "friendly", assistantName: "", greeting: "", benefits: "", objections: "" }),
  terms: z.object({ payment: field(2500), delivery: field(2500), guarantees: field(2500), cancellation: field(2500), discounts: field(2500) }).default({ payment: "", delivery: "", guarantees: "", cancellation: "", discounts: "" }),
  handoff: z.object({ when: field(2000), contact: field(1000) }).default({ when: "", contact: "" }),
  faq: z.array(z.object({ id: itemId, question: field(1000), answer: field(4000) })).max(40).default([]),
  knowledge: z.array(z.object({ id: itemId, title: field(300), content: field(65000) })).max(40).default([]),
  additionalInstructions: field(60000),
}).strict();

export type AiManagerDraft = z.infer<typeof aiManagerDraftSchema>;
export function emptyAiManagerDraft(name = ""): AiManagerDraft {
  return aiManagerDraftSchema.parse({ company: { name } });
}
export type AiSetupIssue = { code: string; field: string; level: "error" | "warning"; message: string };
export type AiSetupKnowledge = { title: string; content: string };
export type AiSetupCompiled = { prompt: string; knowledge: AiSetupKnowledge[]; issues: AiSetupIssue[] };
export type AiSetupVersion = { id: string; createdAt: string; label: string; current: boolean };
export type AiSetupState = {
  revision: number;
  draft: AiManagerDraft;
  savedAt: string | null;
  publishedAt: string | null;
  hasPublished: boolean;
  liveChanged: boolean;
  hasDraftChanges: boolean;
  generated: AiSetupCompiled;
  versions: AiSetupVersion[];
  activation?: { note: string; prompt?: { live: boolean; reason: string }; knowledge?: { live: boolean; reason: string } };
};
export type AiSetupPreview = { sandbox: true; reply: string; handoff: boolean; reason?: string | null };

const ROLE_INSTRUCTIONS: Record<AiManagerRole, string> = {
  consultation: "Объясняй услуги и условия понятным языком. Сначала ответь на вопрос клиента, затем при необходимости уточни потребность. Не навязывай покупку.",
  sales: "Выясни потребность клиента, предложи подходящий вариант из базы знаний, объясни пользу и согласуй следующий шаг. Не дави, не обещай неуказанные скидки и не изображай дефицит или срочность без фактов.",
  qualification: "Выясни задачу, значимые требования и перечисленные компанией данные. Спрашивай только необходимое, не повторяй уже полученные сведения. Подготовь краткую сводку для сотрудника, не объявляй заявку созданной без подтверждения CRM.",
  booking: "Помоги выбрать услугу и собери пожелания по дате и времени. Без подтверждения доступности и результата от подключённой системы это запрос на запись, а не подтверждённая бронь. Передай запрос сотруднику; не выдумывай свободные слоты.",
  support: "Уточни проблему и предложи проверенные шаги из базы знаний. Не проси пароли и коды доступа. Если инструкции не решают вопрос, передай сотруднику с кратким описанием уже выполненных шагов.",
};
const normalized = (text: string) => text.trim().toLocaleLowerCase().replace(/\s+/g, " ");
const facts = (rows: Array<[string, string]>) => rows.filter(([, value]) => value.trim()).map(([label, value]) => `${label}: ${value}`).join("\n");

/** Deterministic compilation keeps the owner's facts intact; no model invents missing business data. */
export function compileAiManagerDraft(draft: AiManagerDraft): AiSetupCompiled {
  const issues: AiSetupIssue[] = [];
  const issue = (code: string, field: string, message: string, level: "error" | "warning" = "error") => issues.push({ code, field, level, message });
  const roles = [...new Set([draft.primaryRole, ...draft.additionalRoles])];
  if (!draft.company.name) issue("company_name", "company.name", "Укажите название компании.");
  if (!draft.company.description) issue("company_description", "company.description", "Расскажите, чем занимается компания.");
  if (!draft.conversation.goal) issue("goal", "conversation.goal", "Укажите, к какому результату ИИ должен привести разговор.");
  if (!draft.company.contacts && !draft.handoff.contact) issue("contact", "handoff.contact", "Добавьте контакт для передачи сложного вопроса сотруднику.", "warning");
  if (!draft.conversation.completion) issue("completion", "conversation.completion", "Опишите следующий шаг после успешного разговора.", "warning");
  if (roles.some(role => ["consultation", "sales", "booking"].includes(role)) && !draft.offerings.length) issue("offerings", "offerings", "Добавьте хотя бы одну услугу или товар.");
  if (roles.includes("qualification") && !draft.conversation.questions) issue("qualification_questions", "conversation.questions", "Перечислите сведения, которые нужно собрать по заявке.");
  if (roles.includes("booking") && !draft.conversation.questions) issue("booking_questions", "conversation.questions", "Укажите, что уточнить для заявки на запись.");
  if (roles.includes("support") && !draft.faq.some(item => item.answer) && !draft.knowledge.some(item => item.content)) issue("support_knowledge", "faq", "Добавьте ответы или инструкции для поддержки.");
  const seenOfferings = new Map<string, string>();
  draft.offerings.forEach((item, i) => {
    if (!item.name || !item.description) issue("offering_details", `offerings.${i}`, "Заполните название и описание услуги или товара.");
    if (!item.price) issue("offering_price", `offerings.${i}.price`, "Укажите цену или напишите, что её рассчитывает менеджер.", "warning");
    const key = normalized(item.name);
    if (key && seenOfferings.has(key)) issue("duplicate_offering", `offerings.${i}.name`, "Есть услуги с одинаковым названием. Объедините их или уточните названия.");
    seenOfferings.set(key, item.price);
  });
  const seenQuestions = new Set<string>();
  draft.faq.forEach((item, i) => {
    if (!item.question || !item.answer) issue("faq_details", `faq.${i}`, "Заполните вопрос и утверждённый ответ.");
    const key = normalized(item.question);
    if (key && seenQuestions.has(key)) issue("duplicate_faq", `faq.${i}.question`, "Вопрос повторяется. Оставьте один согласованный ответ.");
    seenQuestions.add(key);
  });
  draft.knowledge.forEach((item, i) => {
    if (!item.title || !item.content) issue("knowledge_details", `knowledge.${i}`, "Заполните название и содержание материала.");
  });
  const style = { friendly: "Доброжелательный, спокойный, профессиональный", business: "Деловой, вежливый, точный", concise: "Краткий, конкретный, без лишних вступлений" }[draft.conversation.style];
  const prompt = [
    `Ты ИИ-менеджер компании «${draft.company.name || "Название не заполнено"}». Основная функция: ${AI_MANAGER_ROLE_LABELS[draft.primaryRole]}.`,
    `Приоритет основной функции: ${ROLE_INSTRUCTIONS[draft.primaryRole]}`,
    ...roles.filter(role => role !== draft.primaryRole).map(role => `Дополнительная функция — ${AI_MANAGER_ROLE_LABELS[role]}: ${ROLE_INSTRUCTIONS[role]}`),
    facts([["Имя помощника", draft.conversation.assistantName], ["Стиль", style], ["Цель разговора", draft.conversation.goal], ["Что последовательно выяснять", draft.conversation.questions], ["Успешный результат и следующий шаг", draft.conversation.completion], ["Предпочтительное приветствие (только в начале нового диалога)", draft.conversation.greeting], ["Работа с возражениями", draft.conversation.objections], ["Когда нужна помощь сотрудника", draft.handoff.when], ["Кому и как передать вопрос", draft.handoff.contact]]),
    "Сначала ответь на текущий вопрос, затем задай не более одного-двух нужных уточнений. Учитывай уже сказанное и не проводи анкетирование заново. При сочетании функций выбирай подходящую по запросу клиента, сохраняя основную цель.",
    "Если в базе нет цены, срока, условия или ответа, прямо скажи, что нужно уточнение у сотрудника. Отсутствие сведений не означает бесплатную услугу, отсутствие ограничений или согласованную скидку.",
    "Расписание, аудиторию, запрет контакта и передачу сотруднику определяет CRM. Эти инструкции не разрешают обходить её настройки. Не заявляй об оплате, оформлении, отправке документа или подтверждённой записи без результата соответствующего действия системы.",
    draft.additionalInstructions ? `Дополнительные инструкции владельца (действуют только в пределах общих правил BasQar):\n${draft.additionalInstructions}` : "",
  ].filter(Boolean).join("\n\n");
  const knowledge: AiSetupKnowledge[] = [];
  const add = (title: string, content: string) => { if (content.trim()) knowledge.push({ title, content }); };
  add("О компании", facts([["Название", draft.company.name], ["Деятельность", draft.company.description], ["Клиенты", draft.company.audience], ["География и адреса", draft.company.geography], ["Контакты", draft.company.contacts], ["Часы работы компании", draft.company.hours], ["Подтверждённые преимущества", draft.conversation.benefits]]));
  draft.offerings.forEach(item => add(`Услуга / товар: ${item.name}`, facts([["Описание", item.description], ["Цена и порядок расчёта", item.price], ["Что входит", item.includes], ["Сроки", item.timing], ["Ограничения", item.restrictions]])));
  add("Условия работы", facts([["Оплата", draft.terms.payment], ["Доставка / оказание услуг", draft.terms.delivery], ["Гарантии", draft.terms.guarantees], ["Отмена и возврат", draft.terms.cancellation], ["Скидки", draft.terms.discounts]]));
  draft.faq.forEach(item => add(`Вопрос: ${item.question}`, item.answer));
  draft.knowledge.forEach(item => add(item.title, item.content));
  if (prompt.length + knowledge.reduce((n, item) => n + item.title.length + item.content.length + 10, 0) > 65000) issue("context_size", "knowledge", "Материалов слишком много для одного ответа. Сократите повторы и оставьте до 65 000 символов инструкций и знаний.");
  return { prompt, knowledge, issues };
}
