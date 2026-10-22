import { z } from "zod";

export const SALES_GOALS = {
  qualified: "Подготовить квалифицированную заявку",
  meeting: "Договориться о встрече или звонке",
  proposal: "Довести до отправки предложения",
  order: "Согласовать заказ",
  payment: "Довести до подтверждённой оплаты",
} as const;
export const salesProcessSchema = z.object({
  mode: z.enum(["off", "suggest", "auto"]).default("off"),
  goal: z.enum(["qualified", "meeting", "proposal", "order", "payment"]).default("order"),
  assigneeMembershipId: z.string().uuid().nullable().default(null),
  nextStepHours: z.number().int().min(1).max(720).default(24),
  ensureNextStep: z.boolean().default(true),
  syncDocuments: z.boolean().default(true),
  notifyResponsible: z.boolean().default(true),
}).strict();
export type SalesProcessSettings = z.infer<typeof salesProcessSchema>;
export function parseSalesProcess(raw: unknown): SalesProcessSettings {
  const result = salesProcessSchema.safeParse(raw);
  return result.success ? result.data : salesProcessSchema.parse({});
}
export function salesProcessPrompt(raw: unknown): string {
  const settings = parseSalesProcess(raw);
  if (settings.mode === "off") return "";
  return ["Сопровождение продажи", `Цель: ${SALES_GOALS[settings.goal]}.`,
    "Уточни задачу клиента, предложи подходящий вариант из базы знаний, проверь согласие на следующий шаг. Задавай по одному-два вопроса, учитывай уже известное.",
    "Пока потребность или намерение покупки не ясны, продолжай консультацию. Отказ уважай: не дави и не повторяй предложение после отказа.",
    "Согласуй состав заказа, цену и следующий шаг только по утверждённым сведениям. Индивидуальную скидку, нестандартные условия, жалобу или неизвестный ответ передай сотруднику.",
    "Карточки, задачи, документы и платежи подтверждает CRM. Не утверждай, что сделка создана, встреча забронирована, документ отправлен или платёж получен без подтверждённого результата соответствующей операции.",
    "Согласие купить и обещание заплатить не являются оплатой. Настройка цели не разрешает отправку сообщений вне правил канала, расписания и повторных контактов.",
  ].join("\n");
}
