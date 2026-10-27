import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PROCESS_CALENDAR, processCalendarSchema, processRuleText } from "@creolab/contracts";
import { createProcessClock } from "./services/processCalendar.ts";
import { flagsForDeal, nextStepForDeal } from "./services/dealProcessPolicy.ts";
import { parseOpsSettings } from "./services/dealPipeline.ts";

const business = { ...DEFAULT_PROCESS_CALENDAR, mode: "business" as const, end: "17:00" };
const at = (local: string) => new Date(`${local}:00+05:00`);
const almost = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

describe("operational business calendar", () => {
  it("keeps calendar mode as the backwards-compatible default", () => {
    const ops = parseOpsSettings({}); assert.equal(ops.processCalendar.mode, "calendar");
    const clock = createProcessClock(ops.processCalendar, "Asia/Almaty", at("2026-10-26T10:00"));
    almost(clock.elapsedDays(at("2026-10-23T16:00")), 2.75);
    assert.equal(clock.afterDays(at("2026-10-23T16:00"), 1).toISOString(), at("2026-10-24T16:00").toISOString());
  });
  it("counts only working time across a weekend and supports partial days", () => {
    const clock = createProcessClock(business, "Asia/Almaty", at("2026-10-26T10:00"));
    almost(clock.elapsedDays(at("2026-10-23T16:00")), 0.25);
    assert.equal(clock.afterDays(at("2026-10-23T16:00"), 1).toISOString(), at("2026-10-26T16:00").toISOString());
    almost(clock.elapsedDays(at("2026-10-24T09:00")), 0.125);
  });
  it("counts a full week once without duplicate boundary shifts", () => {
    const clock = createProcessClock(business, "Asia/Almaty", at("2026-10-26T09:00"));
    almost(clock.elapsedDays(at("2026-10-19T09:00")), 5);
    almost(clock.elapsedDays(at("2026-10-23T17:00")), 0);
    almost(clock.elapsedDays(at("2026-10-27T09:00")), 0);
    almost(clock.elapsedDays(new Date(NaN)), 0);
  });
  it("excludes specific dates using the company's local date", () => {
    const clock = createProcessClock({ ...business, excludedDates: ["2026-10-26"] }, "Asia/Almaty", at("2026-10-27T10:00"));
    almost(clock.elapsedDays(at("2026-10-23T16:00")), 0.25);
    assert.equal(clock.afterDays(at("2026-10-23T16:00"), 1).toISOString(), at("2026-10-27T16:00").toISOString());
  });
  it("attributes the next morning to the previous overnight shift", () => {
    const night = { ...business, days: [5], start: "22:00", end: "06:00" };
    const clock = createProcessClock(night, "Asia/Almaty", at("2026-10-24T06:00"));
    almost(clock.elapsedDays(at("2026-10-23T22:00")), 1);
    almost(clock.elapsedDays(at("2026-10-24T02:00")), 0.5);
    assert.equal(clock.afterDays(at("2026-10-23T22:00"), 1).toISOString(), at("2026-10-24T06:00").toISOString());
    almost(createProcessClock({ ...night, excludedDates: ["2026-10-23"] }, "Asia/Almaty", at("2026-10-24T06:00")).elapsedDays(at("2026-10-23T22:00")), 0);
  });
  for (const [start, end] of [["2026-03-08T00:00:00-05:00", "2026-03-08T04:00:00-04:00"],
    ["2026-11-01T00:00:00-04:00", "2026-11-01T04:00:00-05:00"]]) {
    it(`handles a full shift across a clock change: ${start}`, () => {
      const clock = createProcessClock({ ...business, days: [0], start: "00:00", end: "04:00" }, "America/New_York", new Date(end));
      almost(clock.elapsedDays(new Date(start)), 1);
      assert.equal(clock.afterDays(new Date(start), 1).getTime(), new Date(end).getTime());
    });
  }
  it("uses local weekdays in a different time zone", () => {
    const from = new Date("2026-10-23T16:00:00-04:00"), to = new Date("2026-10-26T10:00:00-04:00");
    almost(createProcessClock(business, "America/New_York", to).elapsedDays(from), 0.25);
  });
  it("matches adding days and counting them across many shifts and exclusions", () => {
    for (const calendar of [business, { ...business, start: "20:00", end: "04:00", excludedDates: ["2026-10-23", "2026-11-02"] }]) {
      const from = at("2026-10-22T13:45");
      for (const count of [0.25, 1, 4, 11, 30, 100]) {
        const to = createProcessClock(calendar, "Asia/Almaty").afterDays(from, count);
        almost(createProcessClock(calendar, "Asia/Almaty", to).elapsedDays(from), count);
      }
    }
  });
  it("counts long histories without a day-by-day scan", () => {
    const clock = createProcessClock(business, "Asia/Almaty", at("2026-10-26T09:00"));
    // Almaty used UTC+6 in 2016; the same local hour has a different offset.
    almost(clock.elapsedDays(new Date("2016-10-31T09:00:00+06:00")), 521 * 5);
  });
  for (const patch of [{ days: [] }, { days: [1, 1] }, { days: [7] }, { start: "25:00" }, { start: "17:00", end: "17:00" },
    { excludedDates: ["2026-02-30"] }, { excludedDates: ["not-a-date"] }, { mode: "unknown" }]) {
    it(`rejects an invalid schedule ${JSON.stringify(patch)}`, () => {
      assert.equal(processCalendarSchema.safeParse({ ...business, ...patch }).success, false);
    });
  }
  it("ignores corrupt stored durations without disabling a default SLA", () => {
    const ops = parseOpsSettings({ ops: { stalledDealDays: -1, silenceReturnDays: NaN, stageSlaDays: { contract: -10, invoiced: null }, processCalendar: { mode: "bad" } } });
    assert.equal(ops.stalledDealDays, 5); assert.equal(ops.silenceReturnDays, 7);
    assert.equal(ops.stageSlaDays.contract, 5); assert.equal(ops.stageSlaDays.invoiced, null); assert.equal(ops.processCalendar.mode, "calendar");
  });
});

describe("one policy for deal attention", () => {
  const now = at("2026-10-26T10:00");
  const base = { nextAction: null, nextActionAt: null, stageEnteredAt: at("2026-10-23T16:00"), stage: { systemKey: "new" }, tasks: [] };
  const ops = parseOpsSettings({ ops: { stalledDealDays: 2, silenceReturnDays: 7, processCalendar: business } });
  const flags = (patch: Partial<Parameters<typeof flagsForDeal>[0]> = {}) => flagsForDeal({ ...base, ...patch }, ops, now);
  it("does not hide a missing plan behind undated text or an undated task", () => {
    assert.equal(flags().nextActionIssue, "missing_action");
    assert.equal(flags({ nextAction: "Позвонить" }).nextActionIssue, "missing_deadline");
    assert.equal(flags({ nextAction: "  " }).nextActionIssue, "missing_action");
    assert.equal(flags({ tasks: [{ status: "open", dueAt: null }] }).noNextAction, true);
    assert.equal(flags({ nextActionAt: at("2026-10-27T12:00") }).noNextAction, true);
  });
  it("accepts a dated action or open/waiting task but not a closed task", () => {
    assert.equal(flags({ nextAction: "Позвонить", nextActionAt: at("2026-10-27T12:00") }).noNextAction, false);
    for (const status of ["open", "in_progress", "waiting"]) {
      assert.equal(flags({ tasks: [{ status, dueAt: at("2026-10-27T12:00") }] }).noNextAction, false);
      assert.equal(flags({ tasks: [{ status, dueAt: at("2026-10-25T12:00") }] }).overdueTask, true);
    }
    for (const status of ["done", "canceled"]) assert.equal(flags({ tasks: [{ status, dueAt: at("2026-10-27T12:00") }] }).noNextAction, true);
    assert.equal(nextStepForDeal({ ...base, tasks: [{ status: "open", dueAt: new Date(NaN) }] }).issue, "missing_deadline");
  });
  it("does not treat a weekend as a business delay", () => {
    assert.equal(flags().stalled, false); almost(flags().controlDaysOnStage, 0.25);
    assert.equal(flagsForDeal(base, parseOpsSettings({ ops: { stalledDealDays: 2 } }), now).stalled, true);
  });
  it("waiting for the customer never suppresses an explicit overdue deadline", () => {
    const value = flags({ nextAction: "Ждём решение клиента", nextActionAt: at("2026-10-25T15:00") });
    assert.equal(value.waitingClient, true); assert.equal(value.overdueNextAction, true); assert.equal(value.stalled, true);
  });
  it("an overdue linked task remains actionable even with another future task", () => {
    const value = flags({ tasks: [{ status: "open", dueAt: at("2026-10-25T10:00") }, { status: "open", dueAt: at("2026-10-27T12:00") }] });
    assert.equal(value.overdueTask, true); assert.equal(value.stalled, true); assert.equal(value.noNextAction, false);
  });
  it("a future plan suppresses idle warnings but not an exceeded stage SLA", () => {
    const future = { nextAction: "Позвонить", nextActionAt: at("2026-10-27T12:00"), stageEnteredAt: at("2026-10-01T09:00") };
    assert.equal(flags(future).stalled, false);
    assert.equal(flags({ ...future, stage: { systemKey: "proposal_sent" } }).overSla, true);
  });
  it("a reply after entering the proposal stage stops the unanswered-proposal warning", () => {
    const proposal = { stage: { systemKey: "proposal_sent" }, stageEnteredAt: at("2026-10-01T09:00") };
    assert.equal(flags(proposal).proposalWithoutReply, true);
    assert.equal(flags({ ...proposal, contact: { lastInboundMessageAt: at("2026-10-02T09:00") } }).proposalWithoutReply, false);
  });
  it("does not generate process alarms on a closed or paused deal", () => {
    for (const outcome of ["won", "lost", "on_hold"]) {
      const value = flags({ outcome, stageEnteredAt: at("2026-10-01T09:00"), nextAction: "Позвонить", nextActionAt: at("2026-10-02T09:00") });
      assert.equal(value.stalled, false); assert.equal(value.noNextAction, false); assert.equal(value.overdueNextAction, false);
    }
  });
  it("presents every attention reason in the company's language", () => {
    const scenarios = [
      flags({ stage: { systemKey: "proposal_sent" }, stageEnteredAt: at("2026-10-01T09:00") }),
      flags({ nextAction: "Ждём клиента", nextActionAt: at("2026-10-25T12:00") }),
      flags({ tasks: [{ status: "waiting", dueAt: at("2026-10-25T12:00") }] }),
      flags({ nextAction: "Позвонить" }),
    ];
    for (const reason of new Set(scenarios.flatMap(item => item.reasons))) {
      assert.equal(processRuleText("ru", reason), reason);
      assert.notEqual(processRuleText("kk-KZ", reason), reason);
    }
  });
});
