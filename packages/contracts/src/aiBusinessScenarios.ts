import { z } from "zod";

export const INTAKE_KINDS = ["booking", "product_order", "food_order"] as const;
export type IntakeKind = typeof INTAKE_KINDS[number];
export const INTAKE_LABELS = {
  booking: ["Запись на услугу", "Қызметке жазылу", "Service booking"],
  product_order: ["Заказ товаров", "Тауар тапсырысы", "Product order"],
  food_order: ["Заказ еды и продуктов", "Тағам және азық-түлік тапсырысы", "Food and grocery order"],
} as const;
export const INTAKE_FIELDS = {
  service: ["Услуга", "Қызмет", "Service"],
  preferredDate: ["Желаемая дата", "Қалаған күн", "Preferred date"],
  preferredTime: ["Желаемое время", "Қалаған уақыт", "Preferred time"],
  specialist: ["Специалист", "Маман", "Specialist"],
  location: ["Филиал или место", "Филиал немесе орын", "Branch or location"],
  customerName: ["Имя клиента", "Клиент аты", "Customer name"],
  contact: ["Контакт для связи", "Байланыс дерегі", "Contact details"],
  items: ["Позиции и количество", "Атаулар мен саны", "Items and quantities"],
  fulfillment: ["Доставка или самовывоз", "Жеткізу немесе алып кету", "Delivery or pickup"],
  address: ["Адрес доставки", "Жеткізу мекенжайы", "Delivery address"],
  desiredTime: ["Когда нужен заказ", "Тапсырыс қашан керек", "Requested time"],
  paymentMethod: ["Способ оплаты", "Төлем тәсілі", "Payment method"],
  notes: ["Особые пожелания", "Ерекше тілектер", "Special requests"],
} as const;
export type IntakeField = keyof typeof INTAKE_FIELDS;
export const INTAKE_ALLOWED_FIELDS: Record<IntakeKind, IntakeField[]> = {
  booking: ["service", "preferredDate", "preferredTime", "specialist", "location", "customerName", "contact", "notes"],
  product_order: ["items", "fulfillment", "address", "desiredTime", "customerName", "contact", "paymentMethod", "notes"],
  food_order: ["items", "fulfillment", "address", "desiredTime", "customerName", "contact", "paymentMethod", "notes"],
};
export const INTAKE_REQUIRED: Record<IntakeKind, IntakeField[]> = {
  booking: ["service", "preferredDate", "preferredTime", "contact"],
  product_order: ["items", "fulfillment", "contact"],
  food_order: ["items", "fulfillment", "contact"],
};
const field = z.enum(Object.keys(INTAKE_FIELDS) as [IntakeField, ...IntakeField[]]);
const rules = (kind: IntakeKind) => z.object({
  requiredFields: z.array(field).max(13).default(INTAKE_REQUIRED[kind]).refine(keys => keys.every(key => INTAKE_ALLOWED_FIELDS[kind].includes(key)) && INTAKE_REQUIRED[kind].every(key => keys.includes(key)), "Проверьте обязательные поля сценария"),
  instructions: z.string().trim().max(4000).default(""),
}).strict();
export const aiIntakeSettingsSchema = z.object({
  confirmation: z.enum(["staff", "automatic"]).default("staff"),
  fulfillment: z.array(z.enum(["delivery", "pickup"])).min(1).max(2).default(["delivery", "pickup"]),
  booking: rules("booking").default({ requiredFields: INTAKE_REQUIRED.booking, instructions: "" }),
  product_order: rules("product_order").default({ requiredFields: INTAKE_REQUIRED.product_order, instructions: "" }),
  food_order: rules("food_order").default({ requiredFields: INTAKE_REQUIRED.food_order, instructions: "" }),
}).strict();
export type AiIntakeSettings = z.infer<typeof aiIntakeSettingsSchema>;
export const defaultAiIntakeSettings = () => aiIntakeSettingsSchema.parse({});
export function intakeKindsForRoles(roles: readonly string[]): IntakeKind[] {
  return INTAKE_KINDS.filter(kind => roles.includes(kind));
}
export function compileIntakeInstructions(roles: readonly string[], raw?: AiIntakeSettings) {
  const kinds = intakeKindsForRoles(roles);
  if (!kinds.length) return "";
  const settings = raw || defaultAiIntakeSettings();
  return ["Приём записи и заказов: сбор заявки для проверки сотрудником. Эти ограничения подтверждения и правила обязательных полей сохраняются при любых дополнительных инструкциях владельца.",
    ...kinds.map(kind => `${INTAKE_LABELS[kind][0]}. Последовательно выясни: ${settings[kind].requiredFields.map(key => INTAKE_FIELDS[key][0]).join(", ")}. ${settings[kind].instructions}`),
    "Используй уже известные достоверные данные клиента. Не спрашивай контакт повторно, если он доступен в CRM. Не придумывай недостающие значения; спрашивай по одному-два пункта.",
    kinds.some(k => k !== "booking") ? `Получение заказа: ${settings.fulfillment.map(value => value === "delivery" ? "доставка" : "самовывоз").join(" или ")}. Для доставки обязательно уточни адрес; для самовывоза не требуй адрес доставки. Уточни точные позиции, варианты и количество; не подменяй товар без согласия. Цены и условия — только из утверждённых данных. Если итог нельзя достоверно рассчитать, передай расчёт сотруднику.` : "",
    kinds.includes("food_order") ? "Для еды уточни размеры/порции, добавки и исключения по меню. Аллергию и ограничения передавай сотруднику; не гарантируй отсутствие аллергена или безопасность блюда без подтверждения кухни. Не выдумывай состав, остатки, время приготовления и стоимость доставки." : "",
    kinds.includes("booking") ? "Дата и время — пожелания клиента. Не объявляй слот свободным и не создавай подтверждённую бронь без проверки расписания и успешного резервирования." : "",
    "Перед передачей покажи клиенту полную сводку и попроси проверить её. Скажи: «Передам заявку сотруднику для проверки и подтверждения». Не говори «заказ принят», «вы записаны», «оплачено», «готовится» или «отправлено» без подтверждённой операции.",
    "При изменении или отмене уточни, какой запрос имеется в виду, и передай пожелание сотруднику. Просьба клиента отменить или изменить не означает, что операция уже выполнена.",
  ].filter(Boolean).join("\n");
}

const value = z.string().trim().max(1000).nullable().optional();
export const aiIntakeExtractionSchema = z.object({
  kind: z.enum(INTAKE_KINDS), action: z.enum(["collect", "change", "cancel"]).default("collect"),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]), evidenceMessageIds: z.array(z.string().min(1).max(200)).min(1).max(80),
  fields: z.object({ service: value, preferredDate: value, preferredTime: value, specialist: value, location: value,
    customerName: value, contact: value, fulfillment: z.enum(["delivery", "pickup"]).nullable().optional(), address: value,
    desiredTime: value, paymentMethod: value, notes: value }).strict(),
  items: z.array(z.object({ name: z.string().trim().min(1).max(250), quantity: z.number().finite().positive().max(100000).nullable(),
    unit: z.string().trim().max(50).nullable().optional(), variant: value, notes: value }).strict()).max(50).optional(),
}).strict();
export type AiIntakeExtraction = z.infer<typeof aiIntakeExtractionSchema>;
export function missingIntakeFields(input: AiIntakeExtraction, settings: AiIntakeSettings): IntakeField[] {
  const required = [...new Set([...settings[input.kind].requiredFields, ...(input.kind !== "booking" && input.fields.fulfillment === "delivery" ? ["address" as const] : [])])];
  return required.filter(key => key === "items" ? !input.items?.length || input.items.some(item => item.quantity == null)
    : key === "address" && input.fields.fulfillment === "pickup" ? false : !input.fields[key]?.trim());
}

export const aiIntakeRecordSchema = aiIntakeExtractionSchema.extend({
  items: aiIntakeExtractionSchema.shape.items.unwrap().default([]),
  state: z.enum(["collecting", "needs_review"]),
  missingFields: z.array(field),
  sourceMessageId: z.string(), updatedAt: z.string(),
  taskId: z.string().nullable(), fingerprint: z.string(),
});
export type AiIntakeRecord = z.infer<typeof aiIntakeRecordSchema>;
export function readAiIntakeRecords(normalized: unknown): AiIntakeRecord[] {
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return [];
  const records = (normalized as Record<string, unknown>).aiIntake;
  if (!records || typeof records !== "object" || Array.isArray(records)) return [];
  return INTAKE_KINDS.flatMap(kind => {
    const parsed = aiIntakeRecordSchema.safeParse((records as Record<string, unknown>)[kind]);
    return parsed.success && parsed.data.kind === kind ? [parsed.data] : [];
  });
}
