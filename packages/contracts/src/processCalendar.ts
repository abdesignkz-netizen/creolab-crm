import { z } from "zod";

/** Operational deadlines are independent of permission to send AI messages. */
export const processCalendarSchema = /* @__PURE__ */ (() => {
  const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Укажите существующую дату");
  return z.object({
    mode: z.enum(["calendar", "business"]),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7)
      .refine(days => new Set(days).size === days.length, "Дни недели не должны повторяться"),
    start: time,
    end: time,
    excludedDates: z.array(date).max(100),
  }).refine(value => value.start !== value.end, {
    path: ["end"], message: "Начало и конец рабочего дня должны различаться",
  });
})();

export type ProcessCalendar = z.infer<typeof processCalendarSchema>;

export const DEFAULT_PROCESS_CALENDAR: ProcessCalendar = {
  mode: "calendar", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", excludedDates: [],
};
