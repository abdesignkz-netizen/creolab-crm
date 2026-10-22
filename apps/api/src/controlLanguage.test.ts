import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quickControlCommand } from "./services/controlChatLanguage.ts";
const now = new Date("2026-10-21T12:00:00Z");
describe("Control natural language without a model", () => {
  it("understands natural task questions and periods", () => {
    for (const text of ["Какие есть задачи на сегодня", "Покажи мне задачи на сегодня, пожалуйста", "Какие у меня есть задачи на сегодня?", "задачи на сегодня"]) assert.equal(quickControlCommand(text)?.action, "GET_TODAY_TASKS", text);
    assert.deepEqual(quickControlCommand("Покажи продажи за неделю"), { action: "GET_DEALS_STATS", period: "last_7" });
    assert.equal(quickControlCommand("Бүгінгі тапсырмалар?")?.action, "GET_TODAY_TASKS");
    assert.equal(quickControlCommand("Удали задачи на сегодня"), null);
    assert.equal(quickControlCommand("Покажи задачи и удали клиентов"), null);
  });
  it("parses the exact meeting request in the company timezone", () => {
    assert.deepEqual(quickControlCommand("Создай задачу встреча онлайн с Асмед 22 октября в 18:00", "Asia/Almaty", now), { action: "CREATE_TASK", title: "встреча онлайн с Асмед", dueAt: "2026-10-22T13:00:00.000Z" });
    assert.deepEqual(quickControlCommand("Создай задачу: подготовить КП завтра к 15:00", "Asia/Almaty", now), { action: "CREATE_TASK", title: "подготовить КП", dueAt: "2026-10-22T10:00:00.000Z" });
    assert.equal(quickControlCommand("Создай задачу встреча 22.10.2026 в 09:30", "Asia/Almaty", now)?.dueAt, "2026-10-22T04:30:00.000Z");
    assert.equal(quickControlCommand("Создай задачу: подготовить КП завтра", "Asia/Almaty", now)?.dueAt, "2026-10-22T13:00:00.000Z");
  });
  it("never drops an unrecognized deadline or invents a CRM customer", () => {
    assert.equal(quickControlCommand("Создай задачу подготовить отчет в пятницу", "Asia/Almaty", now), null);
    assert.equal(quickControlCommand("Создай задачу для клиента Айбек завтра", "Asia/Almaty", now), null);
    assert.throws(() => quickControlCommand("Создай задачу встреча 31 февраля в 18:00", "Asia/Almaty", now), /Уточните дату/);
    assert.throws(() => quickControlCommand("Создай задачу встреча завтра в 25:00", "Asia/Almaty", now), /Уточните дату/);
  });
});
