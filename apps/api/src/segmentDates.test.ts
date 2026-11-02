import assert from "node:assert/strict";
import { it } from "node:test";
import { segmentDateRange } from "./services/segmentService.ts";

const range = (preset: string, zone: string, now: string) => {
  const result = segmentDateRange(preset, undefined, undefined, zone, new Date(now));
  return [result.from?.toISOString(), result.to?.toISOString()];
};

it("yesterday follows the company date when UTC is still on the previous day", () => {
  assert.deepEqual(range("yesterday", "Asia/Almaty", "2026-11-02T20:00:00Z"), ["2026-11-01T19:00:00.000Z", "2026-11-02T18:59:59.999Z"]);
  assert.deepEqual(range("today", "Asia/Almaty", "2026-11-02T20:00:00Z"), ["2026-11-02T19:00:00.000Z", "2026-11-02T20:00:00.000Z"]);
});

it("uses the company's actual timezone instead of a fixed UTC+5 offset", () => {
  assert.deepEqual(range("yesterday", "UTC", "2026-11-02T20:00:00Z"), ["2026-11-01T00:00:00.000Z", "2026-11-01T23:59:59.999Z"]);
  assert.deepEqual(range("today", "America/New_York", "2026-11-03T01:00:00Z"), ["2026-11-02T05:00:00.000Z", "2026-11-03T01:00:00.000Z"]);
});

it("handles a 25-hour business day and excludes the next midnight", () => {
  assert.deepEqual(range("yesterday", "Europe/Berlin", "2026-10-26T12:00:00Z"), ["2026-10-24T22:00:00.000Z", "2026-10-25T22:59:59.999Z"]);
});

it("handles a 23-hour business day", () => {
  assert.deepEqual(range("yesterday", "Europe/Berlin", "2026-03-30T12:00:00Z"), ["2026-03-28T23:00:00.000Z", "2026-03-29T21:59:59.999Z"]);
});

it("counts lookback days on the company's calendar", () => {
  for (const [preset, from] of [["last_3_days", "2026-10-23T22:00:00.000Z"], ["last_7_days", "2026-10-19T22:00:00.000Z"], ["last_30_days", "2026-09-26T22:00:00.000Z"]]) {
    assert.deepEqual(range(preset, "Europe/Berlin", "2026-10-26T12:00:00Z"), [from, "2026-10-26T12:00:00.000Z"]);
  }
});

it("handles previous-month boundaries across a year", () => {
  assert.deepEqual(range("last_month", "Asia/Almaty", "2026-01-01T20:00:00Z"), ["2025-11-30T19:00:00.000Z", "2025-12-31T18:59:59.999Z"]);
  assert.deepEqual(range("this_month", "America/New_York", "2026-11-03T01:00:00Z"), ["2026-11-01T04:00:00.000Z", "2026-11-03T01:00:00.000Z"]);
});

it("preserves explicitly requested absolute timestamps and an unrestricted period", () => {
  const custom = segmentDateRange("custom", "2026-11-02T12:00:00Z", "2026-11-02T17:00:00+05:00", "Asia/Almaty");
  assert.equal(custom.from?.toISOString(), "2026-11-02T12:00:00.000Z");
  assert.equal(custom.to?.toISOString(), "2026-11-02T12:00:00.000Z");
  assert.deepEqual(segmentDateRange(undefined), { from: undefined, to: undefined });
});
