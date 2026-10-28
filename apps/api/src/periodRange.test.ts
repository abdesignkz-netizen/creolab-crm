import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enumerateBucketKeys,
  formatBucketLabel,
  isoWeekKeyFromYmd,
  zonedLocalToUtc,
} from "./services/periodRange.ts";

describe("period buckets for analytics trend", () => {
  it("enumerates each day of the range and formats Russian labels", () => {
    const from = zonedLocalToUtc("Asia/Almaty", 2026, 9, 1);
    const to = zonedLocalToUtc("Asia/Almaty", 2026, 9, 8);
    const keys = enumerateBucketKeys(from, to, "day", "Asia/Almaty");
    assert.deepEqual(keys, [
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
      "2026-09-07",
    ]);
    assert.match(formatBucketLabel("2026-09-07", "day"), /7/);
    assert.match(formatBucketLabel("2026-09-07", "day"), /сен/i);
  });

  it("builds ISO week keys", () => {
    assert.equal(isoWeekKeyFromYmd({ year: 2026, month: 9, day: 7 }), "2026-W37");
  });
  it("does not duplicate an hour's aggregate on a daylight saving clock rollback", () => {
    const keys = enumerateBucketKeys(new Date("2026-10-24T22:00:00Z"), new Date("2026-10-25T23:00:00Z"), "hour", "Europe/Berlin");
    assert.equal(keys.length, 24); assert.equal(new Set(keys).size, keys.length);
    assert.equal(keys.filter(key => key === "2026-10-25T02").length, 1);
  });
});

it("formats Kazakh trend buckets without changing Russian labels or bucket keys", () => {
  assert.match(formatBucketLabel("2026-09-28", "day", "kk"), /қыр/);
  assert.match(formatBucketLabel("2026-09-28", "day", "ru"), /сент/);
  assert.equal(formatBucketLabel("2026-W40", "week", "kk"), "2026 · апта 40");
  assert.equal(formatBucketLabel("2026-09-28T12", "hour", "kk"), "28.09 12:00");
});
