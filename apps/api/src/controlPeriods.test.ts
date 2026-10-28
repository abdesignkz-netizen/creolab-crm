import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapControlPeriod } from "./services/controlPeriods.ts";
import { chatCommandSchema, quickControlCommand, quickControlPeriodFollowup } from "./services/controlChatLanguage.ts";
import { presentControlReply } from "./services/controlChatPresentation.ts";

describe("Control exact periods and command filters", () => {
  const now = new Date("2026-10-28T07:00:00Z");
  it("separates the calendar week from rolling seven days in the tenant timezone", () => {
    const week = mapControlPeriod({ period: "this_week" }, "Asia/Almaty", now);
    assert.equal(week.dateFrom, "2026-10-26"); assert.equal(week.dateTo, "2026-11-01");
    assert.equal(week.from?.toISOString(), "2026-10-25T19:00:00.000Z");
    assert.equal(week.to?.toISOString(), "2026-11-01T19:00:00.000Z");
    const rolling = mapControlPeriod({ period: "last_7" }, "Asia/Almaty", now);
    assert.equal(rolling.dateFrom, "2026-10-22"); assert.equal(rolling.dateTo, "2026-10-28");
    assert.equal(mapControlPeriod({ period: "last_week" }, "Asia/Almaty", now).dateFrom, "2026-10-19");
  });
  it("uses local weekdays and handles year and DST boundaries", () => {
    const localSunday = mapControlPeriod({ period: "this_week" }, "America/New_York", new Date("2026-10-26T02:00:00Z"));
    assert.equal(localSunday.dateFrom, "2026-10-19"); assert.equal(localSunday.dateTo, "2026-10-25");
    const newYear = mapControlPeriod({ period: "last_week" }, "Asia/Almaty", new Date("2027-01-04T07:00:00Z"));
    assert.equal(newYear.dateFrom, "2026-12-28"); assert.equal(newYear.dateTo, "2027-01-03");
    const dst = mapControlPeriod({ period: "this_week" }, "America/New_York", new Date("2026-03-06T12:00:00Z"));
    assert.equal(dst.to!.getTime() - dst.from!.getTime(), 167 * 3600000);
  });
  it("accepts inclusive exact dates and rejects unknown, conflicting or invalid periods", () => {
    const period = mapControlPeriod({ dateFrom: "2026-10-01", dateTo: "2026-10-02" }, "Asia/Almaty", now);
    assert.equal(period.to?.toISOString(), "2026-10-02T19:00:00.000Z");
    for (const params of [{ period: "future_maybe" }, { period: "custom" }, { period: "today", dateFrom: "2026-10-01", dateTo: "2026-10-02" },
      { period: "custom", dateFrom: "2026-02-30", dateTo: "2026-03-01" }, { period: "custom", dateFrom: "2026-10-03", dateTo: "2026-10-01" }]) {
      assert.throws(() => mapControlPeriod(params, "Asia/Almaty", now));
    }
    assert.equal(mapControlPeriod({}, "Asia/Almaty", now, "all").from, null);
  });
  it("understands exact task scopes, unanswered leads and monthly sales without a model", () => {
    const cases = [
      ["Покажи мои задачи на сегодня", { action: "GET_TODAY_TASKS", scope: "mine", period: "today" }],
      ["Какие у меня есть задачи на сегодня?", { action: "GET_TODAY_TASKS", scope: "mine", period: "today" }],
      ["Покажи просроченные задачи моей команды", { action: "GET_OVERDUE_TASKS", scope: "team" }],
      ["Какие заявки сегодня остались без ответа?", { action: "GET_RECENT_LEADS", leadFilter: "needs_reply", period: "today" }],
      ["Подготовь отчёт по продажам за текущий месяц", { action: "GET_DEALS_STATS", period: "this_month" }],
      ["Покажи задачи за эту неделю", { action: "GET_TASKS", period: "this_week" }],
      ["Покажи продажи с 2026-10-01 по 2026-10-08", { action: "GET_DEALS_STATS", period: "custom", dateFrom: "2026-10-01", dateTo: "2026-10-08" }],
      ["Покажи завершенные задачи за прошлую неделю", { action: "GET_TASKS", taskStatus: "completed", period: "last_week" }],
      ["Осы аптадағы сатылымдарды көрсет", { action: "GET_DEALS_STATS", period: "this_week" }],
      ["Менің командамның мерзімі өткен тапсырмаларды көрсет", { action: "GET_OVERDUE_TASKS", scope: "team" }],
      ["Бүгін жауапсыз қалған өтінімдерді көрсет", { action: "GET_RECENT_LEADS", leadFilter: "needs_reply", period: "today" }],
    ] as const;
    for (const [text, expected] of cases) assert.deepEqual(quickControlCommand(text), expected, text);
    for (const text of ["Покажи мои задачи и удали клиентов", "Продажи за неделю и за месяц", "Покажи задачи за прошлую неделю и назначь Айбека"]) assert.equal(quickControlCommand(text), null, text);
  });
  it("keeps unsupported filters out of model commands and parses bounded follow-ups", () => {
    assert.equal(chatCommandSchema.safeParse({ action: "GET_TASKS", scope: "mine", period: "this_week" }).success, true);
    for (const command of [{ action: "GET_DEALS_STATS", scope: "mine" }, { action: "GET_DEALS_STATS", assignee: "Айбек" }, { action: "GET_RECENT_DEALS", client: "Айбек" },
      { action: "GET_PIPELINE_SUMMARY", period: "last_week" }, { action: "GET_TEAM_STATUS", period: "last_week" },
      { action: "GET_DEALS_STATS", query: "презентации" }, { action: "GET_TASKS", deal: "Большой проект" }, { action: "GET_RECENT_LEADS", dueAt: "2026-10-01T00:00:00Z" },
      { action: "CREATE_TASK", leadFilter: "needs_reply" }, { action: "GET_TODAY_TASKS", period: "last_week" }, { action: "GET_TASKS", period: "custom", dateFrom: "2026-10-01" }]) {
      assert.equal(chatCommandSchema.safeParse(command).success, false);
    }
    assert.deepEqual(quickControlPeriodFollowup("А за прошлую неделю?"), { period: "last_week" });
    assert.deepEqual(quickControlPeriodFollowup("Ал өткен ай?"), { period: "last_month" });
    assert.equal(quickControlPeriodFollowup("А за вчера удали задачи"), null);
  });
  it("shows exact boundaries, total vs displayed and the selected scope in both languages", () => {
    const result = { data: { items: Array.from({ length: 12 }, (_, i) => ({ title: `Task ${i}`, contactName: "Client" })), total: 147, scope: "team" },
      meta: { period: "this_week", dateFrom: "2026-10-26", dateTo: "2026-11-01", timeZone: "Asia/Almaty" } };
    for (const lang of ["ru", "kk"] as const) {
      const reply = presentControlReply("GET_TASKS", result, lang, "Asia/Almaty");
      assert.match(reply, /147/); assert.match(reply, /8/); assert.match(reply, /2026-10-26 — 2026-11-01/);
      assert.doesNotMatch(reply, /Task 8|Сегодня|Бүгін/);
    }
  });
});
