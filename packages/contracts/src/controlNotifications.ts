import { z } from "zod";

export const CONTROL_NOTICE_CATEGORIES = {
  new_inquiries: "Новые заявки",
  assignment: "Назначения сотрудников",
  dialogs: "Диалоги требуют внимания",
  tasks: "Задачи и напоминания",
  deals: "Сделки и документы",
  ai_events: "ИИ нужен сотрудник",
  management: "События сервиса и подписки",
} as const;
export const CONTROL_NOTICE_CATEGORIES_KK: Record<keyof typeof CONTROL_NOTICE_CATEGORIES, string> = {
  new_inquiries: "Жаңа өтінімдер", assignment: "Қызметкерлерге тағайындаулар", dialogs: "Назар аударуды қажет ететін диалогтар", tasks: "Тапсырмалар мен еске салулар", deals: "Мәмілелер мен құжаттар", ai_events: "ЖИ қызметкердің көмегін күтуде", management: "Сервис пен жазылым оқиғалары",
};
export type ControlNoticeCategory = keyof typeof CONTROL_NOTICE_CATEGORIES;
export type ControlNoticeMode = "off" | "instant" | "digest";
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Укажите время в формате ЧЧ:ММ");
const mode = z.enum(["off", "instant", "digest"]);
export const controlNoticeSchema = z.object({
  membershipId: z.string().uuid(),
  integrationId: z.string().uuid(),
  phone: z.string().trim().min(5).max(40),
  recipientConfirmed: z.literal(true),
  enabled: z.boolean(),
  version: z.number().int().nonnegative(),
  events: z.object({ new_inquiries: mode, assignment: mode, dialogs: mode, tasks: mode, deals: mode, ai_events: mode, management: mode }),
  digestTime: time,
  timezone: z.string().min(1).max(80).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Выберите часовой пояс"),
  quietHours: z.object({ enabled: z.boolean(), start: time, end: time }).refine(
    value => !value.enabled || value.start !== value.end,
    { message: "Начало и конец тихих часов должны отличаться", path: ["end"] },
  ),
  minIntervalMinutes: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(60)]),
  urgentDuringQuiet: z.boolean(),
  language: z.enum(["ru", "kk"]),
}).strict();
export type ControlNoticeInput = z.infer<typeof controlNoticeSchema>;
export const CONTROL_NOTICE_DEFAULTS = {
  enabled: false, version: 0, recipientConfirmed: false,
  events: { new_inquiries: "instant", assignment: "off", dialogs: "instant", tasks: "digest", deals: "digest", ai_events: "instant", management: "instant" } as Record<ControlNoticeCategory, ControlNoticeMode>,
  digestTime: "18:00", timezone: "Asia/Almaty",
  quietHours: { enabled: true, start: "22:00", end: "08:00" },
  minIntervalMinutes: 5, urgentDuringQuiet: false, language: "ru",
};
