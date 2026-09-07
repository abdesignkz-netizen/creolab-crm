import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDurationMinutes, formatWaitSince } from "./duration.ts";

describe("formatDurationMinutes", () => {
  it("keeps short waits in minutes", () => {
    assert.equal(formatDurationMinutes(12), "12 мин");
    assert.equal(formatDurationMinutes(0), "меньше минуты");
  });

  it("expands hours instead of 345 мин", () => {
    assert.equal(formatDurationMinutes(345), "5 часов 45 мин");
    assert.equal(formatDurationMinutes(304), "5 часов 4 мин");
    assert.equal(formatDurationMinutes(60), "1 час");
    assert.equal(formatDurationMinutes(120), "2 часа");
  });

  it("uses days and months for longer waits", () => {
    assert.equal(formatDurationMinutes(26 * 60), "1 день 2 часа");
    assert.equal(formatDurationMinutes(2 * 24 * 60), "2 дня");
    assert.equal(formatDurationMinutes(45 * 24 * 60), "1 месяц 15 дней");
    assert.equal(formatDurationMinutes(400 * 24 * 60), "1 год 1 месяц");
  });

  it("builds Ждёт labels", () => {
    assert.equal(formatWaitSince(304), "Ждёт 5 часов 4 мин");
  });
});
